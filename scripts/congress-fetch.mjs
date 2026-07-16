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
export const BILL_TYPES = new Set(['hr', 's', 'hjres', 'sjres']);

const API = 'https://api.congress.gov/v3';
const KEY = process.env.CONGRESS_API_KEY;
if (!KEY) throw new Error('CONGRESS_API_KEY missing');

/** GET one Congress.gov endpoint, retrying on a bad status or a thrown/timed
 *  out request (a hung socket must retry, not kill the whole run - the
 *  2026-06-13 crash). */
export async function cg(path, params = {}) {
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
  const page = await cg(`/bill/${CONGRESS}`, { sort: 'updateDate+desc', limit });
  const items = page.bills ?? [];
  return items.filter((b) => BILL_TYPES.has((b.type ?? '').toLowerCase()));
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
  if (
    text.includes('placed on') || text.includes('calendar') ||
    text.includes('cloture') || text.includes('rule provid') ||
    text.includes('motion to proceed')
  ) return 'floor_vote';
  if (text.includes('markup') || text.includes('ordered to be reported') || text.includes('reported by')) return 'markup';
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
}
