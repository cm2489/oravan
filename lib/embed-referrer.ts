import { countersClient, keyPrefix, noteUpstashError, type UpstashClient } from './upstash';

/*
 * Embed referrer-domain nomination — the F3 ingestion point
 * (docs/ideation/2026-07-05-build-gtm-strategy.md §1.1's F3 row and §8 item
 * 3; docs/ideation/2026-07-02-embeds-spec.md §2.3 item 5's antecedent).
 * This module is the ONLY place domain-nomination keys are built — it is
 * the THIRD registry scripts/check-key-namespaces.mjs gates on, alongside
 * lib/ratelimit.ts (caller-keyed) and lib/scriptcache.ts (content-keyed).
 *
 * WHAT THIS IS, STATED PLAINLY: a host page's browser sends a `Referer`
 * header when it loads an embed page (directly, or inside an iframe via
 * public/embed.js). That header is entirely client-controlled — a bare
 * `curl -H "Referer: https://anyone.example/fake"` can claim to be any
 * domain. So Referer only ever NOMINATES a candidate domain as "might be
 * hosting an embed" — it is NEVER auto-counted as a confirmed install. The
 * actual demand-test verdict (KTD-8/AE4) requires Colby to visit the
 * nominated domain and see the widget live before it counts toward the
 * ≥2/20 gate; that confirmation step is a manual GTM process, not code (see
 * docs/ideation/2026-07-05-build-gtm-strategy.md §8's "Referer-nominated +
 * manually-confirmed installs" line). This module's job ends at "nominate
 * and count" — it has no opinion on, and no path to, "confirmed".
 *
 * TRUNCATION AT INGESTION (the load-bearing property): registrableDomain()
 * below is the ONLY thing this codebase ever does with a Referer header. It
 * reduces a full URL — which can carry a path, a query string, and even a
 * fake click-token designed to look like tracking — down to the
 * registrable domain (eTLD+1) alone, BEFORE anything is ever persisted.
 * Nothing else about the Referer (path, query, fragment, the original
 * string) ever reaches a variable that survives past this function call;
 * noteEmbedReferralDomain (the only caller-facing entry point) never even
 * receives the parsed URL, only the domain-or-null that falls out of it.
 *
 * Key registry — the only shape ever written under this family:
 *
 *   <env>:embed-domain:<YYYY-MM-DD>:<registrable-domain>
 *
 * — an INCR'd daily counter. Content-free (no slug/stance/locale/tool) and
 * caller-free (no IP, no caller hash, no salt) by construction: the domain
 * is the only variable segment, and it is the whole point of this file that
 * it carries nothing else. scripts/check-key-namespaces.mjs enforces this
 * with three dedicated rules (domain-content, domain-caller,
 * domain-raw-referer) — see that file.
 */

// 60 days: long enough to span several 14-day nominate-and-confirm read
// cycles (KTD-8) plus a real review buffer for Colby's manual-confirmation
// visits, short enough that this never becomes a permanent visitor-domain
// ledger — matching the "short-lived" spirit of the counters database even
// though this specific family isn't a rate-limit window.
const DOMAIN_TTL_SECONDS = 60 * 24 * 60 * 60;

// A small, hand-maintained approximation of the IANA Public Suffix List's
// two-label entries — deliberately NOT the `psl`/`tldts` npm package. This
// is a privacy-critical path, and the codebase's stated policy for those
// paths is zero extra supply-chain surface (see lib/upstash.ts's
// REST-over-SDK rationale); this list only needs to be broadly right for
// institutional demand-signal nomination (LION-class local newsrooms,
// libraries, civic orgs), not exhaustively right for every ccTLD on Earth.
// A suffix missing from this list just falls back to "last two labels",
// which is already correct for the overwhelming majority of TLDs
// (.com/.org/.net/.us/.news/etc.) and only over-narrows for two-level
// ccTLDs not listed here — a WRONG NOMINATION CANDIDATE, never a privacy
// leak: the truncation guarantee (no path, no query, no IP) holds
// regardless of exactly where the registrable-domain boundary falls.
const MULTI_LABEL_SUFFIXES = new Set([
  // Common two-level ccTLD suffixes.
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'sch.uk', 'net.uk', 'me.uk',
  'co.nz', 'org.nz', 'govt.nz', 'net.nz', 'ac.nz',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'firm.in',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.mx', 'org.mx', 'gob.mx',
  'co.za', 'org.za', 'gov.za', 'net.za',
  'co.il', 'org.il', 'gov.il', 'net.il',
  'com.sg', 'org.sg', 'gov.sg', 'net.sg',
  'com.hk', 'org.hk', 'gov.hk', 'net.hk',
  'com.tw', 'org.tw', 'gov.tw', 'net.tw',
  // Common privately-registered "one registrant per subdomain" hosting
  // platforms — the whole point of a PSL entry for these is that
  // "myorg.github.io" is myorg's own registrable unit, not github.io's.
  'github.io', 'gitlab.io', 'pages.dev', 'vercel.app', 'netlify.app',
  'web.app', 'firebaseapp.com', 'herokuapp.com', 'wordpress.com',
  'blogspot.com', 'squarespace.com', 'wixsite.com',
]);

function hostLabels(hostname: string): string[] {
  return hostname.split('.').filter(Boolean);
}

/**
 * Reduce a Referer header to its registrable domain (eTLD+1) alone, or null
 * when there is nothing safe/usable to nominate. Handles every shape this
 * ever sees in production gracefully — never throws:
 *
 *   - absent (no Referer sent at all — the common case under a host's
 *     default `strict-origin-when-cross-origin` policy for a cross-origin
 *     navigation, or any host explicitly setting `no-referrer`)
 *   - a bare origin (`https://host.example`) — the other common
 *     cross-origin case
 *   - a full path+query(+fragment) URL — a host page opting into
 *     `Referrer-Policy: unsafe-url`, or a hostile fixture deliberately
 *     shaped like one (this is the ledger's named F3 test)
 *   - malformed / not a parseable absolute URL / a non-http(s) scheme
 *   - a bare IP or a single-label hostname (nothing registrable to nominate)
 *
 * All of the above return null rather than guessing or throwing.
 */
export function registrableDomain(referer: string | null | undefined): string | null {
  if (typeof referer !== 'string' || referer.trim().length === 0) return null;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return null; // malformed — not a parseable absolute URL
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const hostname = url.hostname.toLowerCase();
  const labels = hostLabels(hostname);
  if (labels.length < 2) return null; // "localhost", a bare intranet host — nothing to nominate
  if (/^\d+$/.test(labels[labels.length - 1])) return null; // IPv4 literal, not a domain
  const lastTwo = labels.slice(-2).join('.');
  if (labels.length >= 3 && MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

// --- domain-nomination-database key builder (the whole registry) -----------

/** UTC calendar date, YYYY-MM-DD — the daily bucket a domain's count lives under. */
export function dayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function domainNominationKey(domain: string, day: string): string {
  return `${keyPrefix()}:embed-domain:${day}:${domain}`;
}

// --- the ingestion call ------------------------------------------------------

// In-memory fallback (env absent — local dev/CI/preview without env): same
// shape as lib/ratelimit.ts's memory limiter, a bounded Map that's cleared
// crudely if it grows unreasonably large. Nothing here ever survives a
// redeploy, and that's fine — this path only exists so the ingestion call
// never throws when Upstash isn't configured.
const memoryCounts = new Map<string, number>();
const MEMORY_MAX_ENTRIES = 2000;

let fallbackLogged = false;

/** Test seam only — mirrors lib/ratelimit.ts's single-startup-line seam. */
export function __resetEmbedReferrerFallbackLogForTests(): void {
  fallbackLogged = false;
}

/** Test seam only — reads the in-memory fallback count for one key. */
export function __memoryDomainCountForTests(domain: string, day: string = dayKey()): number {
  return memoryCounts.get(domainNominationKey(domain, day)) ?? 0;
}

function logFallbackOnce(): void {
  if (fallbackLogged) return;
  fallbackLogged = true;
  console.log(
    'embed-referrer: counters database not configured (env absent) — using per-instance in-memory domain-nomination counts (expected in local dev, CI, and previews without env)'
  );
}

function memoryIncrement(key: string): void {
  if (memoryCounts.size >= MEMORY_MAX_ENTRIES) memoryCounts.clear(); // crude memory cap
  memoryCounts.set(key, (memoryCounts.get(key) ?? 0) + 1);
}

async function durableIncrement(client: UpstashClient, key: string): Promise<void> {
  // SET NX EX before INCR: the TTL is attached at creation, mirroring
  // lib/ratelimit.ts's rate-counter pattern, so a crash between commands can
  // never leave a TTL-less (effectively permanent) domain counter.
  const created = await client.cmd(['SET', key, '0', 'NX', 'EX', String(DOMAIN_TTL_SECONDS)]);
  const count = await client.cmd(['INCR', key]);
  if (count === 1 && created !== 'OK') {
    // The key expired between SET and INCR and INCR recreated it bare —
    // rare window-boundary race; re-attach the TTL.
    await client.cmd(['EXPIRE', key, String(DOMAIN_TTL_SECONDS)]);
  }
}

/**
 * The F3 ingestion entry point: called once per embed page load
 * (app/embed/layout.tsx, scheduled via next/server's `after()` so a slow or
 * failed write never delays the widget's own response — the same fail-open
 * posture as every other Upstash write in this repo). Never throws.
 *
 * Referer only NOMINATES a candidate domain — see this file's header
 * comment. Absent, malformed, or otherwise unusable Referers are silently
 * ignored (nothing is written, nothing is logged) rather than treated as an
 * error: most real embed loads won't carry a usable Referer at all (a
 * host's default cross-origin referrer policy already strips path/query,
 * and plenty of hosts send none), and that is the expected common case, not
 * a failure.
 */
export async function noteEmbedReferralDomain(referer: string | null | undefined): Promise<void> {
  const domain = registrableDomain(referer);
  if (!domain) return; // absent/malformed/unusable — nothing to nominate
  const key = domainNominationKey(domain, dayKey());
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
