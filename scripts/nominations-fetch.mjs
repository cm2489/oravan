/**
 * Congress.gov fetch + field-mapping helpers for SENATE NOMINATIONS (PNs) —
 * presidential nominations referred to the Senate for advice and consent.
 * The nomination-side sibling of scripts/congress-fetch.mjs, which stays
 * bills-only; `cg()` (retry, timeout, key handling) is imported from there
 * rather than re-implemented, so there is still exactly one "talk to
 * Congress.gov" primitive in the repo.
 *
 * NAMING: "nomination" here NEVER means the "domain nomination" family in
 * lib/embed-referrer.ts / scripts/check-key-namespaces.mjs (an embed-privacy
 * mechanism for referrer domains). See lib/nomination-status.mjs's header.
 *
 * Needs CONGRESS_API_KEY in the importing process's env (checked by cg() at
 * first fetch, so the pure functions below stay importable by unit tests
 * with no secrets — the same contract congress-fetch.mjs documents).
 *
 * ── WHY LIST-ONLY, AND WHAT IT COSTS ───────────────────────────────────────
 * Everything stored below comes from the LIST endpoint's items. Measured
 * against the live 119th Congress on 2026-08-06, the list item already
 * carries citation, congress, number, partNumber, receivedDate, updateDate
 * and latestAction on 2,039/2,039 records, organization on 2,023, and
 * description on 845 — which is 845 of the 859 CIVILIAN records (the 14
 * civilian records without one are all Foreign Service promotion lists; all
 * 1,180 military records lack one, and we do not ingest those). The DETAIL
 * endpoint adds only `nominees[].positionTitle` and links to actions/
 * committees, and costs one HTTP request PER NOMINATION. So this module
 * never calls it: a nightly run is ONE free request instead of ~90.
 * refreshNominationFields therefore takes a LIST ITEM, unlike
 * congress-fetch.mjs's refreshBillFields which takes a bill-DETAIL payload.
 *
 * ── CIVILIAN ONLY ──────────────────────────────────────────────────────────
 * The 1,180 military nominations of the 119th are bulk promotion lists
 * ("PN130 — 228 nominees for Air Force"): no description, no nameable human,
 * and no question a caller could put to a Senate office. Ingesting them
 * would quadruple the file for zero callable content. `nominationType` is
 * exactly one of { isCivilian: true } or { isMilitary: true } on every live
 * record — never both, never neither — so the filter is unambiguous.
 */
import { execCalendarNumber, mapNominationStatus } from '../lib/nomination-status.mjs';
import { cg } from './congress-fetch.mjs';

/** The Congress this module tracks. Same value, same reason, as
 *  congress-fetch.mjs's CONGRESS — imported separately rather than
 *  re-exported so a future divergence has to be deliberate. */
export const NOMINATION_CONGRESS = 119;

/**
 * Which side of the civilian/military split a raw list item declares — or
 * `'unrecognized'` when it declares NEITHER.
 *
 * The third answer is the point. The header's invariant (`nominationType` is
 * exactly one of `{isCivilian:true}` or `{isMilitary:true}`, re-measured over
 * all 2,077 records of the 119th on 2026-08-09) is what makes the civilian
 * filter an exact test rather than a heuristic — and an invariant nothing
 * checks is an assumption. If Congress.gov renames the field, restructures it,
 * or drops it, every record lands here, `isCivilianNomination` goes false
 * across the board, and the sync ingests nothing while every log line still
 * reads like a quiet night. scripts/sync-nominations.mjs turns a non-zero
 * count here into a loud refusal to advance its cursor — see the tally
 * fetchNominationsSince returns.
 *
 * Deliberately EXACT rather than a count-based heuristic: "zero civilians
 * tonight" is a perfectly normal night (1,197 of the 119th's records are
 * military bulk lists, and plenty of days move only those), so a rule that
 * fired on that would cry wolf until it was ignored. "A record that is
 * neither" cannot happen without an upstream change.
 *
 * @param {{ nominationType?: { isCivilian?: boolean, isMilitary?: boolean } }} item
 * @returns {'civilian' | 'military' | 'unrecognized'}
 */
export function nominationTypeOf(item) {
  const t = item?.nominationType;
  if (t?.isCivilian === true) return 'civilian';
  if (t?.isMilitary === true) return 'military';
  return 'unrecognized';
}

/**
 * Keep only civilian nominations. See the header: `nominationType` carries
 * `isCivilian: true` XOR `isMilitary: true` on all 2,039 live records, so
 * this is an exact test and not a heuristic.
 *
 * @param {{ nominationType?: { isCivilian?: boolean } }} item
 */
export function isCivilianNomination(item) {
  return nominationTypeOf(item) === 'civilian';
}

/**
 * The `latestAction` we are willing to write a record's action-derived fields
 * from, or null when the payload can't be read.
 *
 * The nomination twin of scripts/congress-fetch.mjs's `readableAction`, and a
 * SEPARATE function on purpose rather than an import: that one reads a bill
 * DETAIL payload and this one reads a nomination LIST item (see this file's
 * header for why nominations never call the detail endpoint). The two take
 * different shapes and are allowed to diverge if Congress.gov ever moves one
 * of them; sharing a function would hide that.
 *
 * Readable means it carries action TEXT. Every field refreshNominationFields
 * derives — the status via mapNominationStatus, the Executive Calendar number
 * via execCalendarNumber — is computed from that text, so a payload without
 * it supports no conclusion at all. A bare actionDate with no text is NOT
 * readable: it cannot produce a status, and pinning a newer date onto older
 * stored text would overstate how fresh the record is.
 *
 * @param {{ latestAction?: { text?: string, actionDate?: string } }} item
 */
export function readableNominationAction(item) {
  const action = item?.latestAction;
  return action?.text ? action : null;
}

/**
 * The N most-recently-updated CIVILIAN nominations across the whole 119th
 * Congress — "what changed most recently", no cursor floor. The nomination
 * twin of congress-fetch.mjs's fetchRecentlyUpdated.
 *
 * `limit` is applied by the API BEFORE our civilian filter, so the returned
 * array is normally shorter than `limit`. That is deliberate and safe here:
 * the caller uses this as a freshness window, never as a completeness claim
 * (scripts/sync-nominations.mjs's cursor pass is what guarantees coverage).
 *
 * @param {number} limit  API page size, max 250
 * @returns {Promise<object[]>} civilian list items, newest-updated first
 */
export async function fetchRecentlyUpdatedNominations(limit) {
  // COPIED VERBATIM, INCLUDING THE SPACE, from congress-fetch.mjs:64-72 —
  // read that comment before touching this line. The sort value must reach
  // Congress.gov as "updateDate+desc" ON THE WIRE, where "+" is the URL
  // encoding of a SPACE. URLSearchParams percent-encodes a literal "+" to
  // %2B, which the API silently IGNORES — it does not 400, it just returns
  // the default (ascending) order, so a "recent-first" fetch quietly becomes
  // an oldest-first one and nothing looks broken. That bug ran undetected in
  // the bill sync from 2026-07-16 to 2026-07-23. A space in the JS string
  // serializes to "+" and restores the documented syntax.
  const page = await cg(`/nomination/${NOMINATION_CONGRESS}`, { sort: 'updateDate desc', limit });
  return (page.nominations ?? []).filter(isCivilianNomination);
}

/**
 * Every CIVILIAN nomination updated at or after `since`, oldest-updated
 * first, paging until the API runs out or `maxRecords` raw records have been
 * read. Returns raw list items in API order.
 *
 * `since` MUST already be seconds-precision ISO-8601 — Congress.gov's
 * fromDateTime 400s on a bare date AND on a fractional-seconds timestamp.
 * Live re-verified on the /nomination endpoint 2026-08-06: "2026-08-05" ->
 * 400, "2026-08-05T00:00:00Z" -> 200 (95 records). Normalize with
 * congress-fetch.mjs's toISODateTime before calling. Passing `null` fetches
 * the whole Congress (the one-time backfill: ~9 pages).
 *
 * Also returns a `shape` tally of how every RAW record classified
 * (nominationTypeOf), counted as the pages stream past so it costs no extra
 * memory. `shape.unrecognized > 0` is the upstream-change tripwire the caller
 * refuses to advance its cursor through — see nominationTypeOf.
 *
 * @param {string | null} since  seconds-precision ISO-8601, or null for all
 * @param {{ maxRecords?: number, pageSize?: number }} [opts]
 * @returns {Promise<{ items: object[], rawSeen: number, complete: boolean,
 *   shape: { civilian: number, military: number, unrecognized: number } }>}
 */
export async function fetchNominationsSince(since, opts = {}) {
  const pageSize = opts.pageSize ?? 250; // the API's maximum
  const maxRecords = opts.maxRecords ?? Infinity;
  const items = [];
  const shape = { civilian: 0, military: 0, unrecognized: 0 };
  let rawSeen = 0;
  let offset = 0;
  let complete = true;
  for (;;) {
    const params = { sort: 'updateDate asc', limit: pageSize, offset };
    if (since) params.fromDateTime = since;
    const page = await cg(`/nomination/${NOMINATION_CONGRESS}`, params);
    const raw = page.nominations ?? [];
    rawSeen += raw.length;
    for (const item of raw) {
      const kind = nominationTypeOf(item);
      shape[kind]++;
      if (kind === 'civilian') items.push(item);
    }
    offset += pageSize;
    if (!page.pagination?.next) break;
    if (rawSeen >= maxRecords) {
      complete = false; // more exists upstream; the caller must not advance its cursor past what it read
      break;
    }
  }
  return { items, rawSeen, complete, shape };
}

/**
 * MAY THE CURSOR ADVANCE THROUGH THIS SCAN? — the whole decision, as one
 * pure function, so it can be tested without a network and so
 * scripts/sync-nominations.mjs cannot grow a second opinion about it.
 *
 * The cursor is the only thing that decides which window the next run reads,
 * so advancing it is a claim: "everything before this point is handled." The
 * three verdicts are the three cases where that claim is or is not supportable.
 *
 *   'shape_changed' — EXACT, and fatal. At least one raw record declared
 *       neither isCivilian nor isMilitary (nominationTypeOf), which cannot
 *       happen without an upstream change to a field this whole pipeline
 *       filters on. This is the failure that used to be invisible: the
 *       civilian filter goes false across the board, the sync ingests
 *       nothing, and — with an unconditional advance — the cursor walks past
 *       the records it never read, every night, forever, logging success.
 *
 *   'stalled' — BROADER, and only a warning. Raw records were read and none
 *       were written: a night of degraded replies (all skipped as unreadable),
 *       or simply a window in which only military bulk lists moved. The
 *       second is an ordinary night — 1,197 of the 119th's 2,077 records are
 *       military — which is exactly why this cannot be an error. A gate that
 *       fires on normal nights gets ignored, and an ignored gate is not one.
 *
 *   'ok' — something was written, or there was nothing upstream to read.
 *
 * Holding the cursor costs nothing in either non-ok case: the window is
 * simply re-read next run and the ingest is idempotent (keyed by slug).
 *
 * NO CONSECUTIVE-ZERO COUNTER, deliberately. A persisted counter is a
 * heuristic standing in for "did the filter break?", and 'shape_changed'
 * answers that question exactly, with no false positives. A counter layered
 * on top would fire on a quiet run of military-only nights — real, harmless,
 * and indistinguishable to it.
 *
 * @param {{ rawSeen: number, added: number, refreshed: number, unrecognized: number }} scan
 * @returns {'ok' | 'stalled' | 'shape_changed'}
 */
export function nominationScanVerdict({ rawSeen, added, refreshed, unrecognized }) {
  if (unrecognized > 0) return 'shape_changed';
  if (rawSeen > 0 && added + refreshed === 0) return 'stalled';
  return 'ok';
}

/**
 * THE IDENTITY OF A NOMINATION IS ITS CITATION, NOT ITS NUMBER.
 *
 * A single presidential message can nominate dozens of people at once, and
 * Congress.gov splits it into PARTS that share one number. Live on
 * 2026-08-06: /nomination/119/730 is an African Development Bank nominee
 * (partNumber "00") while /nomination/119/730-18 is a DC Superior Court
 * judge — different people, same `number`. Worse, requesting a partitioned
 * PARENT returns `{"actions":[],"pagination":{"count":0}}`, so dropping the
 * part number yields a nomination that looks permanently inert rather than
 * erroring. Keying on `number` alone would therefore silently collapse
 * dozens of distinct people into one record.
 *
 * The slug reproduces the citation's own arithmetic, which was verified
 * against ALL 2,039 live records (0 mismatches): `PN{number}` when the part
 * is zero, `PN{number}-{part}` otherwise, with the part's LEADING ZEROS
 * STRIPPED — the API returns partNumber "02" but cites it as "PN730-2" and
 * serves it at /730-2. Hence Number(), not the raw string.
 *
 * The `pn-` prefix makes this namespace structurally disjoint from every
 * bill slug (congress-fetch.mjs's slugOf emits `hr-…`, `s-…`, `hjres-…`,
 * `sjres-…`, `hconres-…`, `sconres-…`), so a nomination slug can never be
 * mistaken for — or collide with — a bill slug in any shared map.
 *
 * @param {{ number: number | string, partNumber?: string | null, congress?: number }} item
 * @returns {string} e.g. "pn-730-18-119", or "pn-932-119" when partNumber is "00"
 */
export function nominationSlug(item) {
  const congress = item.congress ?? NOMINATION_CONGRESS;
  const part = Number(item.partNumber ?? 0);
  const base = `pn-${item.number}`;
  return (Number.isInteger(part) && part > 0 ? `${base}-${part}` : base) + `-${congress}`;
}

/**
 * The public Congress.gov page for a nomination.
 *
 * Shape: /nomination/{congress}th-congress/{number}[/{part}], with the part
 * UNPADDED and omitted entirely when zero — the same arithmetic as the
 * citation (see nominationSlug).
 *
 * VERIFICATION NOTE (2026-08-06): www.congress.gov returns 403 to every
 * automated request from this environment — including
 * /bill/119th-congress/house-bill/1, a URL this repo already ships — so the
 * shape could not be confirmed by fetching it. It was instead confirmed
 * against live search-engine-indexed congress.gov pages carrying their own
 * canonical titles: /nomination/119th-congress/937/1 ("PN937-1 — Nomination
 * of David Brat for Department of State"), /nomination/119th-congress/129/7
 * ("PN129-7 — Nomination of Amy Henninger for Department of Defense"), and
 * the part-less /nomination/119th-congress/137 ("PN137 — 29 nominees for
 * Army"). Those three cover both branches of this function and pin the
 * unpadded part.
 *
 * ⚠️ THE CAVEAT THIS NOTE CARRIED HAS BEEN CROSSED (amended 2026-08-06). It
 * read "Nothing renders this field yet; a human should click one before any
 * surface links to it." Both halves are now wrong in the way that matters:
 * app/[locale]/nominations/[slug]/page.tsx renders `congress_gov_url` as the
 * reader-facing outbound link under `nominations.viewOfficial` ("See it on
 * Congress.gov"), on all 857 records — and the human click the note asked for
 * has still NOT happened. So every one of those links ships on indexed-title
 * evidence alone, never on a fetch or a click, and scripts/check-nominations.mjs
 * only re-derives the string from this same builder, which cannot catch a
 * wrong shape. OWNER ITEM, open: click one partitioned and one part-less
 * nomination URL by hand. Until then this is the weakest verified claim on
 * the nomination surface, and it is a claim a reader acts on.
 *
 * @param {number | string} number
 * @param {string | null} [partNumber]
 * @param {number} [congress]
 * @returns {string}
 */
export function congressGovNominationUrl(number, partNumber = null, congress = NOMINATION_CONGRESS) {
  const part = Number(partNumber ?? 0);
  const tail = Number.isInteger(part) && part > 0 ? `/${part}` : '';
  return `https://www.congress.gov/nomination/${congress}th-congress/${number}${tail}`;
}

/**
 * Build a fresh corpus record from a Congress.gov nomination LIST item.
 *
 * `nominee_description` is Congress.gov's own `description` verbatim — the
 * official record sentence ("Christopher Michael De Bono, of the District of
 * Columbia, to be an Associate Judge of the Superior Court…"). It is never
 * rewritten, summarized, or AI-touched anywhere in this pipeline; N1 stores
 * the government's words and nothing else.
 *
 * Returns `null` — MINTS NOTHING — when the list item carries no readable
 * `latestAction` (readableNominationAction). The guard lives here rather than
 * only in the caller because this path is strictly worse than the refresh
 * path it shares a mapper with: there is no prior value for the nulls to
 * contradict, so a record minted from an unreadable reply would enter the
 * corpus permanently asserting `status: 'unclassified'` beside a null date
 * and a null official sentence, and would look exactly like a nomination
 * Congress.gov genuinely has nothing to say about. Nothing is lost by
 * refusing: the record was never stored, so there is nothing to repair, and
 * Congress.gov's own `updateDate` brings it back on the next readable reply.
 *
 * There is no honest null for `status` to store instead. The whole read side
 * — lib/journey.ts's liveCallTargetForNomination, the nomination page's
 * status line, scripts/check-nominations.mjs — expects one of the mapped
 * strings, and every placeholder we could pick would be a claim about the
 * official record we never actually read.
 *
 * @param {object} item  a civilian nomination list item
 * @returns {object | null} a data/nominations.json record, or null if unreadable
 */
export function toNominationRecord(item) {
  if (!readableNominationAction(item)) return null;
  const record = {
    citation: item.citation,
    congress_number: item.congress ?? NOMINATION_CONGRESS,
    pn_number: item.number,
    part_number: item.partNumber ?? '00',
    nominee_description: item.description ?? null,
    organization: item.organization ?? null,
    received_date: item.receivedDate ?? null,
    last_action_date: null,
    last_action_text: null,
    status: 'unclassified',
    exec_calendar_number: null,
    update_date: item.updateDate ?? null,
    congress_gov_url: congressGovNominationUrl(item.number, item.partNumber, item.congress),
  };
  refreshNominationFields(record, item);
  return record;
}

/**
 * Mutate an existing corpus record's refreshable fields in place from a
 * Congress.gov nomination LIST item. Free — no AI, no extra request. The one
 * place the "refresh" mapping lives, so the backfill pass and the nightly
 * incremental pass cannot drift, exactly as refreshBillFields does for bills.
 *
 * The status mapper is lib/nomination-status.mjs's, NOT congress-fetch.mjs's
 * mapStatus(): on the live corpus mapStatus classifies 511 CONFIRMED
 * civilian nominations as `floor_vote` because their record sentence
 * contains "Yea-Nay Vote". See that module's header.
 *
 * Identity fields (citation / pn_number / part_number / congress_number) are
 * deliberately NOT refreshed: they are the record's identity, and a change
 * in them means a different nomination, not an update to this one.
 *
 * ── THE FAIL-CLOSED GUARD ──────────────────────────────────────────────────
 * Returns `'refreshed'` when the payload was readable and the fields were
 * written, or `'skipped_partial'` when it was not and NOTHING was touched.
 * Same posture, same sentinel vocabulary, as the bill side's
 * refreshBillFields — mirrored deliberately rather than shared, because the
 * two read different payload shapes (list item vs. bill detail).
 *
 * A 200 whose `latestAction` carries no readable text is NOT a nomination
 * that went quiet; it is a reply we cannot read (a mid-update record, a
 * degraded Congress.gov response). Every line below used to run anyway, and
 * the damage was silent and terminal-erasing: `mapNominationStatus(null)`
 * returns `unclassified`, `last_action_date` and `last_action_text` were
 * assigned null unconditionally, and `exec_calendar_number` went null too. So
 * ONE degraded reply turned a CONFIRMED nomination — a settled fact about a
 * named private citizen — into a stage-unknown record with its official
 * sentence erased. Worse in the other direction: `unclassified` records are
 * exactly what scripts/check-nominations.mjs sweeps for, so a night of
 * degraded replies would have read as "the Senate said something new" rather
 * than "we could not read the answer".
 *
 * Nothing partial is written, not even the fields that are NOT action-derived
 * (description, organization, receivedDate). A reply missing `latestAction`
 * is a reply we have decided not to trust, and trusting half of it would be a
 * judgement we have no basis for. Nothing is lost by waiting: Congress.gov's
 * own `updateDate` keeps the record inside the next run's window, so a real
 * description backfill re-arrives on the next readable reply.
 *
 * The one present-but-partial payload still written is text WITHOUT an
 * actionDate. The text is the record and maps to a status on its own, and the
 * stored date is PRESERVED rather than nulled, because it is the date of an
 * action that really happened — keeping it can only understate this record's
 * freshness, never overstate it, while null erases the signal outright.
 *
 * @param {object} existing  a data/nominations.json record, mutated in place
 * @param {object} item      a Congress.gov nomination list item
 * @returns {'refreshed' | 'skipped_partial'}
 */
export function refreshNominationFields(existing, item) {
  const action = readableNominationAction(item);
  if (!action) return 'skipped_partial';
  const text = action.text;
  existing.last_action_date = action.actionDate ?? existing.last_action_date ?? null;
  existing.last_action_text = text;
  existing.status = mapNominationStatus(text);
  existing.exec_calendar_number = execCalendarNumber(text);
  existing.update_date = item.updateDate ?? existing.update_date;
  // The description arrives late for some records (Congress.gov backfills the
  // official sentence after the initial receipt row). Never overwrite one we
  // already hold with a null — that would silently blank a record that used
  // to name a human.
  if (item.description) existing.nominee_description = item.description;
  if (item.organization) existing.organization = item.organization;
  if (item.receivedDate) existing.received_date = item.receivedDate;
  // Recompute rather than trust the stored value, the same self-healing
  // refreshBillFields does for congress_gov_url: a record written while the
  // URL builder was wrong repairs itself on its next refresh.
  existing.congress_gov_url = congressGovNominationUrl(
    existing.pn_number,
    existing.part_number,
    existing.congress_number
  );
  return 'refreshed';
}
