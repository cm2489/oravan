import { dayKey } from './embed-referrer';
import { createRateLimiter } from './ratelimit';
import { activeTenantForImpression } from './tenancy';
import { countersClient, keyPrefix, noteUpstashError, type UpstashClient } from './upstash';

/*
 * Impression counting — the F6 ingestion point (docs/ideation/2026-07-05-
 * build-gtm-strategy.md §1.1's F6 row and §1.3's S20 entry;
 * docs/ideation/2026-07-02-embeds-spec.md §2.3 item 5, corrected in this
 * same sprint to describe what actually shipped). This module is the ONLY
 * place impression keys are built — it is the FOURTH registry
 * scripts/check-key-namespaces.mjs gates on, alongside lib/ratelimit.ts
 * (caller-keyed), lib/embed-referrer.ts (domain-keyed), and lib/tenancy.ts
 * (institutional).
 *
 * WHAT THIS IS, STATED PLAINLY: an "impression" is a server-side,
 * token-resolved widget page load — the action panel counts on its own
 * fully-authorized live-render branch (after resolveTenantAccess, the
 * domain check, and a real bill are all confirmed), and rep-lookup/
 * bill-card count when an OPTIONAL `token` query param resolves to an
 * active tenant. These are UNAUTHENTICATED PUBLIC WRITES — a spoofed or
 * replayed request can inflate a count exactly as easily as the site's own
 * `calls:total` counters can be spoofed (KTD-4's own accepted-residual
 * framing). Daily bucketing is the entire mitigation: it bounds a single
 * bad actor's damage to one visible number per tenant per day, never
 * silently blended into a stable running total, and it is disclosed as
 * best-effort in the read endpoint's own response
 * (app/api/tenant/impressions), never presented as audited or fraud-proof.
 *
 * This is a THIRD physical database's-worth of vocabulary living in the
 * COUNTERS database, not a fourth database — tenantId is already
 * precedented as counters-DB-safe institutional "who" material (S19's
 * embed-script/embed-script-day tenant-keyed rate-limit counters already
 * live there; see lib/ratelimit.ts's own header comment). Reusing the same
 * physical database for a second tenant-keyed key family doesn't reopen the
 * "who + what re-pairing" risk lib/upstash.ts's header comment warns
 * about — an impression key carries no content (no slug/stance/locale) and
 * no caller material (no IP/UA/referer), exactly like the rate-limit
 * counters it sits alongside.
 *
 * Key registry — the only shape ever written under this family:
 *
 *   <env>:imp:<tenantId>:<YYYY-MM-DD>     an INCR'd daily counter, TTL 400d
 *
 * IP/UA/referer never enter the write path structurally, not just by
 * discipline: noteImpression's only parameter is tenantId, resolved
 * upstream from a token (resolveTenantAccess for the action panel,
 * activeTenantForImpression for rep-lookup/bill-card) — there is no code
 * path through which a request header could reach it.
 * scripts/check-key-namespaces.mjs enforces this with two dedicated rules
 * (impression-content, impression-caller) mirroring the domain-nomination
 * registry's own — see that file.
 */

// 400 days: "monthly aggregate" is the sold feature (embeds spec's pricing
// table) — a tenant should be able to read a full trailing-12-calendar-
// month window at ANY point they check in, not just the day after
// month-end. Worst case (reading on day 1 of a new month, wanting the prior
// 12 complete months) needs daily buckets going back ~366 days; 400 rounds
// up past that with the same margin instinct the codebase already uses
// elsewhere (lib/embed-referrer.ts's 60d TTL rounds well past its 14-day
// nominate-and-confirm cycle need; lib/tenancy.ts's 7d Stripe-event TTL
// rounds past the ~3-day retry window). No monthly-rollup key is needed at
// this scale — worst case is roughly 50 tenants x 400 daily keys, ~20k
// keys total, trivial for Upstash; a rollup job now would be exactly the
// kind of caching-you-don't-need-yet lib/tenancy.ts's own
// lookupTenantByToken doc comment warns against.
const IMPRESSION_TTL_SECONDS = 400 * 24 * 60 * 60;

// --- impression-database key builder (the whole registry) -------------------

export function impressionDayKey(tenantId: string, day: string): string {
  return `${keyPrefix()}:imp:${tenantId}:${day}`;
}

// --- the ingestion call -------------------------------------------------------

// In-memory fallback (env absent — local dev/CI/preview without env): same
// shape as lib/embed-referrer.ts's own fallback map. Nothing here ever
// survives a redeploy — this path only exists so an impression write never
// throws when Upstash isn't configured.
const memoryCounts = new Map<string, number>();
const MEMORY_MAX_ENTRIES = 2000;

let fallbackLogged = false;

/** Test seam only — mirrors lib/embed-referrer.ts's single-startup-line seam. */
export function __resetImpressionsFallbackLogForTests(): void {
  fallbackLogged = false;
}

/** Test seam only — reads the in-memory fallback count for one key. */
export function __memoryImpressionCountForTests(tenantId: string, day: string = dayKey()): number {
  return memoryCounts.get(impressionDayKey(tenantId, day)) ?? 0;
}

function logFallbackOnce(): void {
  if (fallbackLogged) return;
  fallbackLogged = true;
  console.log(
    'impressions: counters database not configured (env absent) — using per-instance in-memory impression counts (expected in local dev, CI, and previews without env)'
  );
}

function memoryIncrement(key: string): void {
  if (memoryCounts.size >= MEMORY_MAX_ENTRIES) memoryCounts.clear(); // crude memory cap
  memoryCounts.set(key, (memoryCounts.get(key) ?? 0) + 1);
}

async function durableIncrement(client: UpstashClient, key: string): Promise<void> {
  // SET NX EX before INCR: the TTL is attached at creation, mirroring
  // lib/embed-referrer.ts's durableIncrement, so a crash between commands
  // can never leave a TTL-less (effectively permanent) impression counter.
  const created = await client.cmd(['SET', key, '0', 'NX', 'EX', String(IMPRESSION_TTL_SECONDS)]);
  const count = await client.cmd(['INCR', key]);
  if (count === 1 && created !== 'OK') {
    // The key expired between SET and INCR and INCR recreated it bare —
    // rare window-boundary race; re-attach the TTL.
    await client.cmd(['EXPIRE', key, String(IMPRESSION_TTL_SECONDS)]);
  }
}

/**
 * Record one impression for an already-resolved tenant. Called via
 * `after()` at every one of this file's call sites (app/embed/action-panel,
 * app/embed/rep-lookup, app/embed/bill-card) so a slow or failed write can
 * never delay the widget's own response — the same fail-open posture as
 * every other Upstash write in this repo. Never throws.
 */
export async function noteImpression(tenantId: string): Promise<void> {
  const key = impressionDayKey(tenantId, dayKey());
  const client = countersClient();
  if (!client) {
    logFallbackOnce();
    memoryIncrement(key);
    return;
  }
  try {
    await durableIncrement(client, key);
  } catch (err) {
    noteUpstashError('counters', err);
    memoryIncrement(key); // fail open — never blocks or fails the page
  }
}

// --- the optional-token path (rep-lookup / bill-card) ------------------------

// Cost-containment, not security: rep-lookup/bill-card have zero per-IP rate
// limiting today (no AI cost, nothing to protect). A `token` param means
// anyone can attach a garbage token and trigger a background tenancy-database
// GET for free, at whatever volume they want — never a render/security issue
// (worst case: a wasted lookup, and it happens inside `after()` so it can
// never delay or change the response either way), but a new, real Upstash-
// cost surface that didn't exist before. This caps the LOOKUP only; going
// over the cap just skips the lookup for that request, silently — rendering
// is never affected.
const tokenLookupLimiter = createRateLimiter({ route: 'embed-impression-token', max: 30, windowSec: 600 });

/**
 * rep-lookup/bill-card's ingestion entry point. Token absent -> no-op,
 * byte-for-byte (no limiter call, no tenancy lookup, nothing written) —
 * matches the `X-Oravan-Key`-absent doctrine elsewhere in this codebase.
 * Token present-but-invalid/revoked/inactive -> ALSO a silent no-op; these
 * two pages must never gain a new paywall, only the counting no-ops. `ip`
 * is the caller's own IP (lib/ratelimit.ts's callerIp), used only to bound
 * the tenancy-lookup rate — never written to any key here (noteImpression's
 * only parameter is a resolved tenantId).
 */
export async function noteImpressionForToken(token: string | null, ip: string): Promise<void> {
  if (!token) return;
  if (await tokenLookupLimiter.isLimited(ip)) return; // cost cap only, never a render gate
  const tenant = await activeTenantForImpression(token);
  if (tenant) await noteImpression(tenant.tenantId);
}

// --- the tenant read path (app/api/tenant/impressions) -----------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function monthLabel(year: number, month0: number): string {
  return `${year}-${pad2(month0 + 1)}`;
}

function daysInMonthUTC(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function dayString(year: number, month0: number, day: number): string {
  return `${year}-${pad2(month0 + 1)}-${pad2(day)}`;
}

interface MonthBucket {
  year: number;
  month0: number; // JS Date convention: 0 = January
  label: string; // "YYYY-MM"
  partial: boolean; // true only for the current (most recent) bucket
}

/**
 * `count` month buckets ending at `now`'s calendar month, oldest first —
 * the exact ascending order the response JSON documents. Only the LAST
 * bucket (the current month) is ever partial; every earlier one has
 * already fully elapsed.
 */
function monthsWindow(now: Date, count: number): MonthBucket[] {
  const out: MonthBucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const year = d.getUTCFullYear();
    const month0 = d.getUTCMonth();
    out.push({ year, month0, label: monthLabel(year, month0), partial: i === 0 });
  }
  return out;
}

/** Every calendar-day string a bucket could possibly have a key for — never past `now` for the partial bucket. */
function daysForBucket(bucket: MonthBucket, now: Date): string[] {
  const lastDay = bucket.partial ? now.getUTCDate() : daysInMonthUTC(bucket.year, bucket.month0);
  const days: string[] = [];
  for (let day = 1; day <= lastDay; day++) days.push(dayString(bucket.year, bucket.month0, day));
  return days;
}

export interface ImpressionMonth {
  month: string; // "YYYY-MM"
  impressions: number;
  partial: boolean;
}

export type ImpressionsWindowResult =
  | { ok: true; months: ImpressionMonth[]; total: number }
  | { ok: false };

/**
 * Sum daily impression buckets into `monthCount` calendar months for one
 * tenant, oldest first, ending at the current (partial) month. ONE Upstash
 * round trip via MGET, never N sequential GETs.
 *
 * DELIBERATE WRITE/READ ASYMMETRY: noteImpression above fails open and
 * silent (matches every other Upstash write in this repo). This function
 * fails LOUD instead — `{ ok: false }` on an unconfigured counters client,
 * an Upstash request error, or a malformed MGET result, NEVER a
 * silently-degraded number computed from nothing. The in-memory fallback
 * noteImpression itself uses is per-instance and would badly undercount a
 * serverless fleet's real total if this function fell back to it too — a
 * confidently-wrong number is worse than an honest "try again" (the same
 * "never invent, never guess" instinct lib/ratelimit.ts's currentSalt and
 * lib/tenancy.ts's parseTenantRecord already apply, here for
 * honesty-of-the-number rather than security). The caller
 * (app/api/tenant/impressions) turns `{ ok: false }` into 503, never a
 * response body with a number in it.
 */
export async function readImpressionsWindow(
  tenantId: string,
  monthCount: number,
  now: Date = new Date()
): Promise<ImpressionsWindowResult> {
  const client = countersClient();
  if (!client) return { ok: false };

  const buckets = monthsWindow(now, monthCount);
  const dayLists = buckets.map((bucket) => daysForBucket(bucket, now));
  const allKeys = dayLists.flat().map((day) => impressionDayKey(tenantId, day));

  let raw: unknown;
  try {
    raw = await client.cmd(['MGET', ...allKeys]);
  } catch (err) {
    // Accurate wording: this path fails CLOSED (503), not open to
    // in-memory — see lib/upstash.ts's noteUpstashError doc comment.
    noteUpstashError('counters', err, 'failing closed to temporarily_unavailable (impressions read, never a degraded number)');
    return { ok: false };
  }
  if (!Array.isArray(raw) || raw.length !== allKeys.length) return { ok: false };

  let cursor = 0;
  let total = 0;
  const months: ImpressionMonth[] = buckets.map((bucket, i) => {
    const dayCount = dayLists[i].length;
    const slice = raw.slice(cursor, cursor + dayCount);
    cursor += dayCount;
    const impressions = slice.reduce(
      (acc: number, v: unknown) => acc + (typeof v === 'string' ? Number(v) || 0 : 0),
      0
    );
    total += impressions;
    return { month: bucket.label, impressions, partial: bucket.partial };
  });

  return { ok: true, months, total };
}
