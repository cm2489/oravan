/**
 * The KEYLESS House listing for `scripts/sync-votes.mjs --backfill-from`
 * (2026-09-29). The owner asked for every roll call of the current Congress
 * on every tracked bill: "That is public record so let's back fill them all
 * for every bill." The nightly lists the House through the Congress.gov API,
 * which needs CONGRESS_API_KEY; a back-fill run by hand has no key, and does
 * not need one, because the Clerk of the House publishes the same record:
 *
 *   1. `evs/{year}/index.asp` names the year's highest roll number
 *      (parseClerkIndexMax) — one request per session.
 *   2. `evs/{year}/roll{NNN}.xml` for every roll number from 1 up to it. Its
 *      <vote-metadata> alone says the date and the bill (houseClerkMeta); a
 *      roll call on no corpus bill is skipped there, before any member row is
 *      read, and one on a corpus bill goes through parseHouseClerkXml — the
 *      SAME parser the nightly's Clerk fallback uses — and later through the
 *      same gate (verifyVotes) as every other roll call in the file.
 *
 * HOUSE AMENDMENT VOTES ARE SKIPPED, to hold the file to the one rule the
 * nightly applies. The nightly attaches a House roll call to a bill only when
 * Congress.gov's list names the bill in its legislation fields, and for a
 * vote on an amendment in the House (the Clerk's record carries an
 * <amendment-num>) the list leaves those fields empty, so the nightly has
 * never stored one: data/votes.json held no House amendment vote on
 * 2026-09-28. The Clerk's <legis-num> DOES name the bill for those votes, so
 * without this rule the back-fill would add them (measured 2026-09-29: 61
 * roll calls on 11 bills since 2025-01-03) and the file would then hold House
 * amendment votes up to the day of the back-fill and none after it. Checked
 * against the nightly's own output: from the old floor (2026-05-27) to
 * 2026-09-28, every roll call the Clerk walk attached that the nightly had
 * not was an amendment vote (24 of 24), and in 2025 every one the Congress.gov
 * list does not attach was too (22 of 22). Senate amendment votes are
 * unaffected — the Senate record names the bill in the vote itself, and both
 * paths have always kept them. Whether House amendment votes should be kept
 * (and the nightly taught to keep them) is an open owner decision, recorded
 * in the back-fill PR.
 *
 * A roll call the file already holds is not fetched again. Pure apart from
 * the injected `getText`: no fs, no network, no clock, so
 * tests/votes-backfill.unit.spec.ts drives it on fixtures.
 *
 * FAILURE IS PER ROLL CALL AND ALWAYS REPORTED. A 404, a timeout, a record
 * for a different roll number than the URL, or a parse error marks that roll
 * `failed` in `examined`, and the caller's cursor stops below it. The script
 * then refuses to write a back-fill with any failure it is answerable for
 * (backfillBlockers, below; scripts/sync-votes.mjs): a floor is a claim that
 * everything after it is held, and one missing roll call would make "recorded
 * since January 3, 2025" untrue for that bill.
 */
import {
  VoteParseError,
  clerkIndexUrl,
  clerkRollUrl,
  congressFirstYear,
  houseClerkMeta,
  parseClerkIndexMax,
  parseHouseClerkXml,
  rollCallId,
} from './votes-core.mjs';

/**
 * Walk one session of House roll calls from the Clerk's record.
 *
 * @param {{
 *   congress: number,
 *   session: 1|2,
 *   floor: string,
 *   corpus: Set<string>,
 *   held: { has(id: string): boolean, get?(id: string): { date: string } | undefined },
 *   getText: (url: string) => Promise<string>,
 *   getRoll?: (url: string) => Promise<string>,
 *   log?: (line: string) => void,
 * }} args
 *   `getText` fetches the index page (never cached: it grows); `getRoll`
 *   fetches one roll call's XML (defaults to getText; the script passes a
 *   caching reader so a resumed back-fill does not fetch a record twice).
 * @returns {Promise<{
 *   year: number,
 *   maxRoll: number,
 *   parsed: import('./votes-core.mjs').ParsedRollCall[],
 *   examined: Array<{ roll: number, date: string|null, failed?: boolean }>,
 *   stats: { listed: number, inWindow: number, corpus: number, stored: number, failed: number },
 * }>}
 */
export async function walkHouseClerk({ congress, session, floor, corpus, held, getText, getRoll = getText, log = () => {} }) {
  const year = congressFirstYear(congress) + session - 1;
  const maxRoll = parseClerkIndexMax(await getText(clerkIndexUrl(year)), year);
  const stats = { listed: maxRoll, inWindow: 0, corpus: 0, stored: 0, failed: 0 };
  const parsed = [];
  const examined = [];
  for (let n = 1; n <= maxRoll; n++) {
    const id = rollCallId('house', congress, session, n);
    if (held.has(id)) {
      stats.inWindow++;
      stats.corpus++;
      examined.push({ roll: n, date: held.get?.(id)?.date ?? null });
      continue;
    }
    const url = clerkRollUrl(year, n);
    let date = null;
    try {
      const xml = await getRoll(url);
      const meta = houseClerkMeta(xml, { corpus });
      if (meta.congress !== congress || meta.session !== session || meta.roll !== n) {
        throw new VoteParseError(`${url} holds roll ${meta.congress}-${meta.session}-${meta.roll}, not ${congress}-${session}-${n}`);
      }
      date = meta.date;
      if (date < floor) {
        examined.push({ roll: n, date });
        continue;
      }
      stats.inWindow++;
      if (!meta.bill || meta.amendment) {
        examined.push({ roll: n, date });
        continue;
      }
      stats.corpus++;
      const one = parseHouseClerkXml(xml, { corpus, sourceUrl: url });
      if (one.roll.bill !== meta.bill) throw new VoteParseError(`metadata said ${meta.bill}, the parse says ${one.roll.bill}`);
      parsed.push(one);
      stats.stored++;
      examined.push({ roll: n, date });
      log(`  ${id} ${one.roll.date} ${one.roll.bill}: ${one.roll.question} — ${one.roll.result}`);
    } catch (e) {
      stats.failed++;
      examined.push({ roll: n, date, failed: true });
      log(`::error::sync-votes: ${id} not stored — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { year, maxRoll, parsed, examined, stats };
}

/**
 * The failed roll calls a back-fill is answerable for, out of one chamber-
 * session's `examined` list: those that are, or may be, dated BEFORE the
 * file's old floor.
 *
 * WHY ONLY THOSE. A back-fill adds one claim — "recorded since {new floor}" —
 * and that claim is new only for the days before the old floor. From the old
 * floor on, the file already made it, and a roll call the chamber has not
 * published yet (senate.gov answers a same-day vote's XML with a redirect for
 * a few hours) is the nightly's ordinary business: logged, the cursor stops
 * below it, and the next run fetches it. Refusing a whole back-fill over that
 * would make it impossible to land on any day the Senate votes.
 *
 * HOW A FAILURE IS DATED. When the record's date is known (the Senate menu
 * dates every vote; a House record that failed after its metadata was read),
 * it decides. When it is not (a House record that could not be fetched at
 * all), roll numbers run in time order within a session, so the failure is
 * after the old floor only if a LOWER roll number in the same session is
 * already dated on or after it. Otherwise it counts. No old floor (no file
 * yet): every failure counts.
 *
 * @param {Array<{ roll: number, date?: string|null, failed?: boolean }>} examined
 * @param {string|null} oldFloor
 * @returns {number[]} the roll numbers that block the write
 */
export function backfillBlockers(examined, oldFloor) {
  const out = [];
  let reachedOldWindow = false;
  for (const e of [...examined].sort((a, b) => a.roll - b.roll)) {
    const inOldWindow = oldFloor != null && (e.date ? e.date >= oldFloor : reachedOldWindow);
    if (e.date && oldFloor != null && e.date >= oldFloor) reachedOldWindow = true;
    if (e.failed && !inOldWindow) out.push(e.roll);
  }
  return out;
}
