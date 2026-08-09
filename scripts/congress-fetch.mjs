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

export const CONGRESS = 119;
// hconres/sconres added 2026-07-23: concurrent resolutions carry War Powers
// fights and budget resolutions — their exclusion made H.Con.Res.38 (the
// Iran war-powers resolution everyone was talking about) STRUCTURALLY
// unfetchable. Simple resolutions (hres/sres) stay excluded: they are
// chamber-internal and almost never call-worthy.
export const BILL_TYPES = new Set(['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres']);

const API = 'https://api.congress.gov/v3';
const KEY = process.env.CONGRESS_API_KEY;
// Key is checked at first fetch, not at import: this module also exports
// pure functions (mapStatus, urgencyScore, ...) that unit tests import
// without any secrets. Sync scripts still fail on their first cg() call
// with the same message.

/** GET one Congress.gov endpoint, retrying on a bad status or a thrown/timed
 *  out request (a hung socket must retry, not kill the whole run - the
 *  2026-06-13 crash). */
export async function cg(path, params = {}) {
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
  if (
    text.includes('passed house') || text.includes('passed senate') ||
    text.includes('passed/agreed to') || text.includes('agreed to in') ||
    text.includes('received in the senate') || text.includes('received in the house') ||
    text.includes('held at the desk')
  ) return 'passed_chamber';
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
    text.includes('unfinished business')
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

/** Mutate an existing corpus bill's refreshable fields in place from a
 *  Congress.gov bill-detail payload (`cg('/bill/{congress}/{type}/{number}')`'s
 *  `.bill`). Free, no AI cost - the one place both scripts' "refresh" branch
 *  lives, so it can't drift between the nightly sync and the hot-bill pass. */
export function refreshBillFields(existing, detail) {
  const status = mapStatus(detail.latestAction?.text);
  const lastActionDate = detail.latestAction?.actionDate ?? null;
  existing.status = status;
  existing.last_action_date = lastActionDate;
  existing.last_action_text = detail.latestAction?.text ?? existing.last_action_text;
  existing.urgency_score = urgencyScore(status, lastActionDate);
  const tags = tagBill(detail.policyArea?.name);
  if (tags.length) existing.issue_tags = tags;
  existing.policy_area = detail.policyArea?.name ?? existing.policy_area;
  // Recompute rather than trust the stored value: bills decoded while the
  // URL builder was wrong (hconres/sconres, 2026-07-23) self-heal on their
  // next refresh.
  existing.congress_gov_url = congressGovUrl(existing.bill_type, existing.bill_number);
}
