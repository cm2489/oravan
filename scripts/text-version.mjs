/**
 * WHICH DOCUMENT A DECODE WAS PRODUCED FROM — and whether Congress has
 * published a newer one since. Pure and I/O-free, on the decode-gate.mjs
 * precedent, so the decision that spends money is directly unit-testable
 * without mocking Congress.gov or Anthropic (tests/redecode-new-text.unit
 * .spec.ts).
 *
 * THE FAILURE THIS EXISTS FOR, measured 2026-09-18 on the live corpus.
 * H.R. 5634 was reported out of committee WITH AN AMENDMENT on 2026-09-08.
 * Congress.gov's own `Reported in House` text (BILLS-119hr5634rh) sets the
 * Post-9/11 GI Bill flight-training cap at a different figure than the text
 * as introduced — and the site went on printing the introduced number, in
 * both languages, on the bill page and in the homepage hero, for ten days.
 * Nothing was broken: scripts/bill-decode.mjs's existing-bill branch returns
 * refreshBillFields(existing, d) and never re-decodes, so a bill's status,
 * date and urgency track the record while its EXPLANATION is frozen at
 * whatever document it was born from. A bill being amended is the single
 * most likely moment for that explanation to go wrong, and it was the one
 * moment nothing watched.
 *
 * TWO SIGNALS, ONE AUTHORITY. Congress.gov's bill-DETAIL payload — the one
 * the nightly refresh already fetches for every updated bill — carries
 * `textVersions: {count, url}`, so "has a version been added since we last
 * looked" is free (countSaysNewText). It is a HINT ONLY: it decides who gets
 * probed first, never who gets decoded. The authority is dateSaysNewText,
 * which compares the stored provenance against the version actually served
 * and costs one free /text request. Keeping the spend decision on the dated
 * check is what stops a count that moves for a reason other than a new
 * readable document (a version published without Formatted Text, a paginated
 * count) from billing a decode every night forever.
 *
 * WHAT WE STORE, and why each field is the honest one:
 *   text_version_date / text_version_type — the version this record's decode
 *     was produced FROM. Written only at decode time, only after the decode
 *     returned a shape the gate accepted, and only ever describing the
 *     document we actually read (pickTextVersion's pick, NOT blindly
 *     textVersions[0] — see below). Null means unknown, never "old".
 *   text_version_count — how many text versions Congress.gov published WHEN
 *     WE LAST LOOKED. Deliberately a different claim from the two above: it
 *     is written at decode time and also when a probe clears a record, so a
 *     one-version bill stops consuming probe budget every night. It says
 *     nothing about provenance and is never read as if it did.
 *
 * LEGACY RECORDS (no stored date — the whole corpus before this shipped) are
 * treated as decoded from their EARLIEST text version. That is an assumption,
 * stated here so nobody mistakes it for a measurement, and it is the
 * conservative direction: it can only over-trigger a re-read, never let a
 * stale explanation stand. Its practical effect is that any bill holding more
 * than one dated version becomes a candidate — a slow, capped backfill rather
 * than a bill.
 */

const formattedText = (v) =>
  (v?.formats ?? []).find((f) => f?.type === 'Formatted Text')?.url ?? null;

/** The Formatted Text URL of one textVersions entry, or null. */
export function formattedTextUrl(v) {
  return formattedText(v);
}

/**
 * The version of a bill we decode from: the CURRENT one — Congress.gov's
 * /text `textVersions` array as returned, first entry carrying a Formatted
 * Text URL. Null when the bill has no retrievable text at all.
 *
 * MOVED HERE 2026-09-18 from scripts/bill-decode.mjs, unchanged byte for
 * byte, because the re-decode trigger below must ask the SAME question about
 * "the current text" that the decode itself answers — a second copy would be
 * free to disagree, and a disagreement here is a bill that gets re-decoded
 * every night forever or never. bill-decode.mjs re-exports it, so its
 * existing importers and tests/bill-text-source.unit.spec.ts are unchanged.
 *
 * This used to iterate `[...versions].reverse()`, which took the LAST entry
 * and therefore decoded almost every bill from the text as INTRODUCED, no
 * matter how far it had since moved. Live-verified against the API on
 * 2026-08-09, 67 multi-version bills of the 119th:
 *
 *   s/1199    Engrossed in Senate@2026-04-29 | Reported@2025-07-30 | Introduced@2025-03-27
 *   hr/2701   Placed on Calendar Senate@2025-12-09 | Engrossed in House@2025-09-15
 *             | Reported in House@2025-09-09 | Introduced in House@2025-04-07
 *
 * The array is ordered MOST-ADVANCED FIRST. It is NOT simply date-descending,
 * and a future reader must not "fix" it by sorting on `date`: the two
 * terminal texts of an enacted bill sit outside the date order entirely —
 * `Enrolled Bill` is pinned FIRST and carries `date: null`, and `Public Law`
 * is pinned LAST despite holding the NEWEST date (hr/1: Enrolled@null |
 * Engrossed Amendment Senate@2025-07-01 | ... | Reported@2025-05-20 |
 * Public Law@2025-07-05). Measured 2026-08-09: Enrolled first in 25/25 and
 * Public Law last in 25/25 enacted bills sampled, and entry [0] was the
 * most-advanced text in 42/42 in-progress multi-version bills. So entry [0]
 * is the current text in every observed shape, and the old reverse() landed
 * on `Introduced` for everything still moving — while accidentally landing
 * on the correct `Public Law` for bills already enacted, which is why the
 * damage never showed up in the enacted records anyone spot-checked.
 *
 * Versions with no Formatted Text URL are skipped, not treated as the end of
 * the list — the pick is "the newest version we can actually read".
 */
export function pickTextVersion(versions) {
  return (versions ?? []).find((v) => formattedText(v)) ?? null;
}

/**
 * How many text versions Congress.gov reports. `pagination.count` when the
 * /text reply carries one, else the array length.
 *
 * The distinction is load-bearing and not pedantry: cg() fetches /text with
 * no `limit`, so a bill with more versions than the endpoint's default page
 * size would hand back a SHORT array while the bill-detail payload's
 * `textVersions.count` reports the true total. Storing the array length and
 * comparing it against the detail count would then read as "a new version
 * appeared" on every single run, and the count hint would nominate that bill
 * for a probe every night for the life of the corpus. Comparing counts only
 * works if both sides count the same thing.
 */
export function versionCount(payload) {
  if (Number.isFinite(payload?.pagination?.count)) return payload.pagination.count;
  const list = Array.isArray(payload?.textVersions)
    ? payload.textVersions
    : Array.isArray(payload)
      ? payload
      : null;
  return list ? list.length : null;
}

/** The earliest dated version in the list, as the raw string Congress.gov
 *  served, or null when nothing in it carries a parseable date. The baseline
 *  a legacy record is measured from — see the header's LEGACY RECORDS note. */
export function earliestVersionDate(versions) {
  let best = null;
  let bestMs = Infinity;
  for (const v of versions ?? []) {
    const ms = Date.parse(v?.date ?? '');
    if (!Number.isFinite(ms) || ms >= bestMs) continue;
    bestMs = ms;
    best = v.date;
  }
  return best;
}

/**
 * The three provenance fields for a record whose decode was just produced
 * from `picked`, with `count` as reported by versionCount. Returned as a
 * plain object rather than mutating, so the caller writes them in the same
 * breath as `decoded_at` and a failed decode leaves no stamp at all.
 */
export function textVersionStamp(picked, count) {
  return {
    text_version_date: picked?.date ?? null,
    text_version_type: picked?.type ?? null,
    text_version_count: Number.isFinite(count) ? count : null,
  };
}

/**
 * THE FREE HINT. Did the number of published text versions grow since we
 * last looked? Costs nothing — `servedCount` comes out of the bill-detail
 * payload the nightly refresh already paid for.
 *
 * A hint, never a verdict: it nominates a bill for the dated check below and
 * nothing else. A null on either side is "we cannot tell", never "yes" —
 * writing `Number(null)` as 0 here would have made every legacy record look
 * like a bill that just gained its entire text history.
 *
 * @param {{storedCount?: number|string|null, servedCount?: number|string|null}} input
 * @returns {{newer: boolean, reason: string, from?: number, to?: number}}
 */
export function countSaysNewText({ storedCount = null, servedCount = null } = {}) {
  if (storedCount === null || storedCount === undefined) return { newer: false, reason: 'no-stored-count' };
  if (servedCount === null || servedCount === undefined) return { newer: false, reason: 'no-served-count' };
  const from = Number(storedCount);
  const to = Number(servedCount);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { newer: false, reason: 'unparseable-count' };
  if (to > from) return { newer: true, reason: 'count-grew', from, to };
  return { newer: false, reason: 'count-unchanged', from, to };
}

/**
 * THE AUTHORITY. Is the text Congress.gov serves today NEWER than the text
 * this record's decode was produced from?
 *
 * Compared against pickTextVersion's pick, not textVersions[0], for a reason
 * that costs money to get wrong: the stamp records the document we actually
 * read, so measuring against a version we CANNOT read would leave the bill a
 * candidate after its re-decode — a decode billed every night, forever, for a
 * document that never changes. Comparing like with like closes the loop: a
 * re-decode always stamps the same version this function measured.
 *
 * A picked version with no date (an `Enrolled Bill` entry, which Congress.gov
 * pins first and dates null) yields no verdict rather than a guess.
 *
 * @param {{storedDate?: string|null, versions?: any[]|null}} input
 * @returns {{redecode: boolean, reason: string, from?: string, to?: string}}
 */
export function dateSaysNewText({ storedDate = null, versions = null } = {}) {
  const list = Array.isArray(versions) ? versions : [];
  if (!list.length) return { redecode: false, reason: 'no-versions' };
  const picked = pickTextVersion(list);
  const served = picked?.date ?? null;
  if (!served) return { redecode: false, reason: 'no-dated-text' };
  const baseline = storedDate ?? earliestVersionDate(list);
  if (!baseline) return { redecode: false, reason: 'no-baseline' };
  const from = Date.parse(baseline);
  const to = Date.parse(served);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return { redecode: false, reason: 'unparseable-date' };
  }
  if (to <= from) {
    return {
      redecode: false,
      reason: storedDate ? 'current-text-decoded' : 'legacy-no-newer-text',
      from: baseline,
      to: served,
    };
  }
  return {
    redecode: true,
    reason: storedDate ? 'new-text-version' : 'legacy-backfill',
    from: baseline,
    to: served,
  };
}

/**
 * THE MONEY CEILING. How many re-decodes a run may actually pay for, and in
 * what order.
 *
 * 10 a night. A re-decode is two Sonnet calls on the same prompts a first
 * decode uses, so the worst case this admits is ~10 × $0.065 ≈ $0.65/night —
 * a number small enough that the trigger above never needs an owner in the
 * loop, and a ceiling low enough that the legacy backfill is deliberately
 * slow. Slow is correct here: a bill amended today is a candidate tonight,
 * and a bill amended last March waits its turn behind it.
 */
export const DEFAULT_REDECODE_MAX_PER_NIGHT = 10;

/**
 * How many free /text probes one run may spend confirming candidates.
 *
 * Probes cost no money, only a Congress.gov request and a fraction of a
 * second each, so this is a runner-time budget rather than a spend one. It
 * sits comfortably above DEFAULT_REDECODE_MAX_PER_NIGHT because probing more
 * bills than we can re-decode is what keeps the ORDER honest: the queue is
 * sorted by urgency, so a night that probes 40 bills and re-decodes 10 is
 * re-reading the ten most-likely-to-be-seen amended bills, not the first ten
 * it happened to meet.
 */
export const DEFAULT_REDECODE_PROBE_LIMIT = 40;

/**
 * How much re-decoding a trigger of each kind is worth, lowest first. Forced
 * slugs are an explicit owner order. Then a KNOWN change: 'new-text-version'
 * means Congress published a text newer than the one THIS record was stamped
 * from — a dated event we watched happen. Last, a SUSPECTED one:
 * 'legacy-backfill' means the record predates the stamp and holds more than
 * one version, so it MIGHT have been decoded from an older text.
 *
 * The order is load-bearing, not cosmetic. Almost the whole corpus is in the
 * backfill bucket — measured 2026-09-18 against the live data, 23 of the 26
 * highest-urgency bills qualify — so ranking on urgency alone would let that
 * backlog fill every slot on the cap and push a bill amended this morning to
 * tomorrow night, which is the backfill crowding out the signal it exists to
 * serve. Within a tier, urgency decides: re-read what a reader is about to
 * open.
 */
const TRIGGER_RANK = { forced: 0, 'new-text-version': 1, 'legacy-backfill': 2 };

/**
 * Split the night's candidates into what gets paid for and what waits.
 *
 * FORCED SLUGS GO FIRST AND STILL COUNT. FORCE_REDECODE_SLUGS is an explicit
 * owner order and jumps the queue, but it does NOT lift the ceiling: a
 * fifty-slug list re-decodes ten tonight and the rest tomorrow, so the
 * worst-case nightly bill stated above holds no matter what reaches the env
 * var. There is exactly one knob for spend (REDECODE_MAX_PER_NIGHT) and no
 * path around it.
 *
 * A cap that isn't a finite non-negative number falls back to the default
 * rather than to zero or to NaN — `slice(0, NaN)` silently returns nothing,
 * which would have made a typo'd env var look exactly like a quiet night.
 * The caller reports `cap` so a fallback is visible in the run log.
 *
 * @param {{forced?: string[], detected?: {slug: string, reason?: string, from?: string, to?: string, fetchedTitle?: string|null, urgency?: number}[], cap?: number}} input
 * @returns {{run: {slug: string, reason: string}[], deferred: {slug: string, reason: string}[], cap: number}}
 */
export function planRedecodes({ forced = [], detected = [], cap = DEFAULT_REDECODE_MAX_PER_NIGHT } = {}) {
  const limit =
    Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : DEFAULT_REDECODE_MAX_PER_NIGHT;
  const seen = new Set();
  const queue = [];
  for (const slug of forced) {
    const key = String(slug ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    queue.push({ slug: key, reason: 'forced' });
  }
  for (const cand of detected) {
    const key = String(cand?.slug ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    queue.push({ ...cand, slug: key, reason: cand?.reason ?? 'new-text-version' });
  }
  // A stable sort (Array#sort is stable per spec since ES2019), so candidates
  // the caller already ordered keep that order inside their tier when no
  // urgency is supplied.
  queue.sort((a, b) => {
    const rank = (TRIGGER_RANK[a.reason] ?? 3) - (TRIGGER_RANK[b.reason] ?? 3);
    if (rank !== 0) return rank;
    return (Number(b.urgency) || 0) - (Number(a.urgency) || 0);
  });
  return { run: queue.slice(0, limit), deferred: queue.slice(limit), cap: limit };
}
