/**
 * Nightly coverage sync. For every eligible bill (decoded, non-terminal),
 * fetch real news articles (TheNewsAPI), keep only the ones genuinely about
 * the bill (a Haiku relevance gate — it authors nothing), and write
 * them to data/coverage.json keyed by bill slug. The render path joins each
 * article's source to an outlet lean from data/media-bias.json (AllSides).
 *
 *   node --env-file=.env.local scripts/sync-coverage.mjs
 *
 * Gated on NEWS_API_KEY: with no key this is a no-op that leaves the committed
 * sample untouched (so the PR stays demoable). Also needs ANTHROPIC_API_KEY.
 *
 * Static-first is preserved: this runs in CI, bakes results to JSON, and the
 * site makes zero runtime third-party calls.
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { TERMINAL_STATUSES, effectiveUrgency } from '../lib/urgency.mjs';
import { queryFor } from './coverage-query.mjs';

const NEWS_API_KEY = process.env.NEWS_API_KEY;
if (!NEWS_API_KEY) {
  console.log('NEWS_API_KEY missing — skipping coverage sync (committed sample preserved).');
  process.exit(0);
}

// Capped at the 600 most-deserving eligible bills per night (owner decision,
// 2026-08-05; was 150 from 2026-07-16, itself raised from an unbounded
// Infinity).
//
// WHY 150 EXISTED, AND WHY IT WAS THE WRONG SHAPE OF FIX: at Infinity the run
// walked every eligible bill in urgency order and burned TheNewsAPI's daily
// quota before reaching the bottom, so the same low-ranked bills starved every
// night. 150 stopped the starvation by refusing to try - but it was never
// sized against the quota. Measured 2026-08-05: TheNewsAPI Basic allows 2,500
// requests/day and the run was using ~150, i.e. 6% of a quota already paid
// for, while 88.5% of the bills carrying a "Read" section had coverage older
// than 30 days.
//
// THE ACTUAL FIX IS THE SPLIT BELOW, not the number. Half the budget goes to
// the urgency head (what a reader is most likely to open tonight) and half
// rotates through the bills checked longest ago. Starvation is solved by
// guaranteeing the tail a share, not by shrinking the window - so breadth now
// compounds across a week instead of re-checking the same head every night.
//
// The news API's daily quota remains the real ceiling: the run stops early and
// commits what it has if quota is hit. 25 candidates/bill is TheNewsAPI's
// Basic-tier per-request max.
/* `Number(process.env.X ?? d)` is a trap here: an env var set to the empty
   string is not nullish, so `?? d` never fires and Number('') is 0 — a blank
   COVERAGE_TOP_N would silently process zero bills and report success. CI
   passes these through from workflow_dispatch inputs, which are '' when the
   operator leaves the box empty, so this is a live path, not a hypothetical. */
const envNum = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`::warning::${name}="${raw}" is not a number — using ${fallback}`);
    return fallback;
  }
  return n;
};

const TOP_N = envNum('COVERAGE_TOP_N', 600);
const PER_BILL = envNum('COVERAGE_PER_BILL', 5);
const MAX_CANDIDATES = envNum('COVERAGE_MAX_CANDIDATES', 25);
// Fraction of the nightly budget reserved for the least-recently-checked tail.
// 0 restores pure urgency order (the pre-2026-08-05 behaviour).
const TAIL_SHARE = envNum('COVERAGE_TAIL_SHARE', 0.5);
// Bills processed concurrently. The loop was strictly sequential (one fetch +
// one Haiku call at a time), which is what made a wide sweep impractical on
// wall-clock rather than on cost. Keep this modest: TheNewsAPI rate-limits per
// 60s window and the pacing logic in fetchArticles is shared mutable state.
const CONCURRENCY = envNum('COVERAGE_CONCURRENCY', 6);
const NEWS_API = 'https://api.thenewsapi.com/v1/news/all';
const CONGRESS_START = '2025-01-03'; // 119th Congress convened; coverage can't predate a bill

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rlRemaining = Infinity; // X-RateLimit-Remaining from the last response

const anthropic = new Anthropic({ maxRetries: 8 });
const MODEL = 'claude-haiku-4-5-20251001';

const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));

// Last committed coverage. Eligible bills this run doesn't reach (quota stop,
// per-bill failure, or a COVERAGE_TOP_N test run) carry their previous entry
// forward, so a partial night can only ever update or add coverage — never
// silently shrink the file. Bills the run DOES process always take tonight's
// fresh result, even when that result is empty.
let prevCoverage = {};
try {
  prevCoverage = JSON.parse(readFileSync('data/coverage.json', 'utf8'));
} catch {
  /* first run or unreadable file — nothing to carry forward */
}

function slugOf(b) {
  return `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
}

/* When each bill was last LOOKED AT (not when its newest article was
   published). Carried in coverage.json under a "_"-prefixed key, which
   getCoverage() already ignores, so this is invisible to the render path.
   Without it there is no way to tell "no new news exists" from "not checked
   since March" - the gap that let 88.5% of the file go >30 days stale behind
   a site-wide freshness stamp (owner escalation, 2026-08-05). */
const prevCheckedAt =
  prevCoverage && typeof prevCoverage._checkedAt === 'object' && prevCoverage._checkedAt !== null
    ? prevCoverage._checkedAt
    : {};
const checkedAt = { ...prevCheckedAt };
const RUN_DAY = new Date().toISOString().slice(0, 10);

// Urgency comes from lib/urgency.mjs — the same module the live site ranks
// with — so this script and the site always agree on which bills are "top band".
const eligible = bills
  .filter((b) => b.ai_headline && !TERMINAL_STATUSES.has(b.status))
  .map((b) => ({ b, eff: effectiveUrgency(b.status, b.last_action_date) }))
  .sort((x, y) => y.eff - x.eff || (y.b.last_action_date ?? '').localeCompare(x.b.last_action_date ?? ''));

/* THE HEAD/TAIL SPLIT. The head is pure urgency order - what a reader is most
   likely to open tonight. The tail is whatever has gone longest without a look,
   oldest first, with never-checked bills sorted ahead of everything (empty
   string precedes any ISO date). A bill already claimed by the head is never
   double-counted. If the tail runs dry the head absorbs the remainder, so a
   small corpus still uses the full budget. */
const headSize = Math.max(0, Math.min(TOP_N, Math.round(TOP_N * (1 - TAIL_SHARE))));
const head = eligible.slice(0, headSize);
const claimed = new Set(head.map(({ b }) => slugOf(b)));
const tail = eligible
  .filter(({ b }) => !claimed.has(slugOf(b)))
  .map((e) => ({ ...e, seen: checkedAt[slugOf(e.b)] ?? '' }))
  .sort((x, y) => x.seen.localeCompare(y.seen) || y.eff - x.eff)
  .slice(0, TOP_N - head.length);
const overflow = eligible
  .filter(({ b }) => !claimed.has(slugOf(b)) && !tail.some((t) => slugOf(t.b) === slugOf(b)))
  .slice(0, TOP_N - head.length - tail.length);

const topBills = [...head, ...tail, ...overflow].map(({ b }) => b);

console.log(
  `coverage sync: ${topBills.length} bills of ${eligible.length} eligible ` +
    `(${head.length} by urgency + ${tail.length} least-recently-checked${overflow.length ? ` + ${overflow.length} overflow` : ''}), ` +
    `PER_BILL=${PER_BILL}, CONCURRENCY=${CONCURRENCY}`
);

/* Drop syndicated duplicates: the same wire story republished by many outlets
   shares a title (and would otherwise count as many separate "sources"). */
function dedupeArticles(arts) {
  const seenTitle = new Set();
  const seenUrl = new Set();
  const out = [];
  for (const a of arts) {
    const t = (a.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if ((t && seenTitle.has(t)) || (a.url && seenUrl.has(a.url))) continue;
    if (t) seenTitle.add(t);
    if (a.url) seenUrl.add(a.url);
    out.push(a);
  }
  return out;
}

/*
 * TheNewsAPI adapter — the ONLY provider-specific code. To swap providers,
 * reimplement this to return the same {title,url,source,snippet,publishedAt}
 * shape (source = bare outlet domain, e.g. "cnn.com"). Returns null on a
 * quota/rate signal so the caller can stop early and commit what it has.
 */
async function fetchArticles(query, publishedAfter) {
  const url = new URL(NEWS_API);
  url.searchParams.set('api_token', NEWS_API_KEY);
  url.searchParams.set('search', query);
  url.searchParams.set('language', 'en');
  url.searchParams.set('locale', 'us'); // US outlets only - US bills, AllSides-rated world
  url.searchParams.set('limit', String(MAX_CANDIDATES));
  url.searchParams.set('sort', 'relevance_score');
  if (publishedAfter) url.searchParams.set('published_after', publishedAfter); // coverage can't predate the bill

  let lastErr;
  for (let attempt = 0; attempt <= 6; attempt++) {
    // Proactive throttle: if this 60s window's budget is spent, wait it out
    // rather than firing a request we know will 429.
    if (rlRemaining <= 0) { console.log('  rate budget spent — waiting 60s for the window to reset'); await sleep(60_000); rlRemaining = Infinity; }
    else if (attempt > 0) await sleep(2000 * attempt);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const rem = Number(res.headers.get('x-ratelimit-remaining'));
      if (Number.isFinite(rem)) rlRemaining = rem;
      if (res.ok) {
        const data = await res.json();
        return dedupeArticles((data.data ?? []).map((a) => ({
          title: a.title,
          url: a.url,
          source: a.source, // TheNewsAPI returns the bare domain
          snippet: a.description ?? a.snippet ?? null,
          publishedAt: a.published_at ? a.published_at.slice(0, 10) : null,
        })));
      }
      if (res.status === 429) {
        // 60s-window rate limit vs daily quota: only the latter should stop us.
        const body = await res.json().catch(() => ({}));
        const code = `${body?.error?.code ?? body?.error ?? ''}`.toLowerCase();
        if (/usage|daily|quota|plan|limit_reached_today/.test(code)) {
          console.error('TheNewsAPI daily quota exhausted — stopping early'); return null;
        }
        console.log('  rate limited (429) — waiting 60s and retrying'); await sleep(60_000); rlRemaining = Infinity;
        continue;
      }
      if (res.status === 402) { console.error('TheNewsAPI 402 (quota) — stopping early'); return null; }
      lastErr = new Error(`TheNewsAPI ${res.status}`);
    } catch (e) {
      lastErr = e; // network error / timeout — retry
    }
  }
  throw lastErr ?? new Error('TheNewsAPI: exhausted retries');
}

/* Search query construction lives in scripts/coverage-query.mjs (shared with
   the eval harness and pinned by tests/coverage-query.unit.spec.ts). */

/* Haiku relevance gate: keep only articles specifically about THIS bill. */
async function filterRelevant(b, candidates) {
  if (candidates.length === 0) return [];
  const list = candidates
    .map((a, i) => `${i}. ${a.title}${a.snippet ? ` — ${a.snippet}` : ''} (${a.source})`)
    .join('\n');
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 80,
    messages: [{ role: 'user', content: `A US congressional bill:
${b.bill_type.toUpperCase()} ${b.bill_number} — ${b.ai_headline ?? b.title}
What it does: ${b.ai_sections?.tldr ?? b.ai_summary ?? b.title}

Below are news articles. Return ONLY the numbers of articles specifically about THIS bill (its provisions, votes, debate, or signing) — not merely the general topic, and not a different bill. Reply with a comma-separated list of numbers, or "none".

${list}` }],
  });
  const text = (msg.content[0]?.type === 'text' ? msg.content[0].text : '').toLowerCase();
  const keep = new Set(
    text.split(/[^0-9]+/).filter(Boolean).map(Number).filter((n) => n >= 0 && n < candidates.length)
  );
  return candidates.filter((_, i) => keep.has(i)).slice(0, PER_BILL);
}

// ---- main ----
const out = {};
const processedSlugs = new Set();
let anyFetchOk = false;
let withCoverage = 0;
let totalArticles = 0;

/* Fresh results plus previous coverage for still-eligible bills not (yet)
   processed this run — whether unreached (quota stop), failed, or outside a
   COVERAGE_TOP_N selection. Used for every write so neither a checkpoint
   file nor a partial final write can drop an unprocessed bill's coverage.
   Entries for bills that went terminal (or left the corpus) still age out. */
const eligibleSlugs = new Set(
  bills.filter((b) => b.ai_headline && !TERMINAL_STATUSES.has(b.status)).map(slugOf)
);
function withCarryForward() {
  const merged = { ...out };
  for (const [slug, arts] of Object.entries(prevCoverage)) {
    if (slug.startsWith('_') || processedSlugs.has(slug)) continue;
    if (eligibleSlugs.has(slug) && Array.isArray(arts) && arts.length) {
      merged[slug] = arts;
    }
  }
  /* Ages out with the corpus: a bill that went terminal or left entirely
     shouldn't keep a check date, or the tail would sort stale ghosts to the
     front forever. Included in every checkpoint write so a crashed run keeps
     its rotation position. */
  merged._checkedAt = Object.fromEntries(
    Object.entries(checkedAt).filter(([slug]) => eligibleSlugs.has(slug))
  );
  return merged;
}

/* One bill, start to finish. Returns 'quota' when TheNewsAPI signals the daily
   ceiling so the caller can stop the whole run; 'ok' or 'fail' otherwise. A
   FAILED bill is deliberately NOT marked checked - it carries its old coverage
   forward AND stays at the front of tomorrow's tail, so a transient error can
   never quietly retire a bill from rotation. */
async function processBill(b) {
  const slug = slugOf(b);
  try {
    const candidates = await fetchArticles(queryFor(b), b.introduced_date ?? CONGRESS_START);
    if (candidates === null) return 'quota';
    anyFetchOk = true;
    const kept = await filterRelevant(b, candidates);
    processedSlugs.add(slug); // fresh result stands, even when empty
    checkedAt[slug] = RUN_DAY; // looked at tonight, regardless of what we found
    if (kept.length) {
      out[slug] = kept;
      withCoverage++;
      totalArticles += kept.length;
    }
    console.log(`${slug}: ${candidates.length} candidates -> ${kept.length} kept`);
    return 'ok';
  } catch (e) {
    console.error(`FAIL ${slug}: ${e.message}`); // not processed — carries forward
    return 'fail';
  }
}

/* Batched rather than sequential (2026-08-05). The old loop awaited one fetch
   and one Haiku call per bill, which is why a wide sweep was impractical on
   wall-clock even though the quota had room. Batches keep the shared pacing
   state in fetchArticles coherent enough while cutting elapsed time ~CONCURRENCY-fold.
   A quota signal anywhere in a batch stops the run after that batch drains -
   in-flight work is never discarded. */
let processed = 0;
for (let i = 0; i < topBills.length; i += CONCURRENCY) {
  const batch = topBills.slice(i, i + CONCURRENCY);
  const results = await Promise.all(batch.map((b) => processBill(b)));

  processed += batch.length;
  // Checkpoint per batch so a long, rate-limited run never loses progress.
  writeFileSync('data/coverage.json', JSON.stringify(withCarryForward()));

  if (results.includes('quota')) {
    console.error(`TheNewsAPI daily quota exhausted after ${processed} bills — stopping early`);
    break;
  }
}

// Never clobber the existing file when the API never responded — preserve the
// current coverage (or the committed sample) and let the next run self-heal.
if (!anyFetchOk) {
  console.warn('No successful TheNewsAPI responses; leaving data/coverage.json unchanged.');
  process.exit(0);
}

const finalOut = withCarryForward();
// Count bills only — withCarryForward() also sets the "_checkedAt" metadata key,
// which would otherwise show up as one phantom carried-forward bill.
const carried =
  Object.keys(finalOut).filter((k) => !k.startsWith('_')).length - Object.keys(out).length;
finalOut._note = 'Generated by scripts/sync-coverage.mjs. Articles via TheNewsAPI; outlet lean is joined at render from data/media-bias.json (AllSides). Keys starting with "_" are metadata, ignored by getCoverage().';

writeFileSync('data/coverage.json', JSON.stringify(finalOut));
/* Staleness is now measurable, so print it: this is the number that went
   unwatched until 2026-08-05 and the one to check after a wide refresh. */
const staleDays = (iso) => Math.round((Date.now() - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000);
const ages = Object.keys(finalOut)
  .filter((k) => !k.startsWith('_'))
  .map((slug) => (finalOut._checkedAt[slug] ? staleDays(finalOut._checkedAt[slug]) : Infinity));
const neverChecked = ages.filter((d) => d === Infinity).length;
const over30 = ages.filter((d) => d !== Infinity && d > 30).length;

console.log(
  `DONE: ${withCoverage}/${topBills.length} bills with coverage, ${totalArticles} articles total` +
    `${carried ? ` (+${carried} unprocessed bills carried forward)` : ''}`
);
console.log(
  `FRESHNESS: ${ages.length - neverChecked - over30} checked within 30d, ` +
    `${over30} older than 30d, ${neverChecked} never checked`
);
