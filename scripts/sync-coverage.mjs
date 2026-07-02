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

// Cover every eligible bill by default (the news API's daily quota is the real
// ceiling; the run stops early and commits what it has if quota is hit). 25
// candidates/bill is TheNewsAPI's Basic-tier per-request max.
const TOP_N = Number(process.env.COVERAGE_TOP_N ?? Infinity);
const PER_BILL = Number(process.env.COVERAGE_PER_BILL ?? 5);
const MAX_CANDIDATES = Number(process.env.COVERAGE_MAX_CANDIDATES ?? 25);
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

// Urgency comes from lib/urgency.mjs — the same module the live site ranks
// with — so this script and the site always agree on which bills are "top band".
const topBills = bills
  .filter((b) => b.ai_headline && !TERMINAL_STATUSES.has(b.status))
  .map((b) => ({ b, eff: effectiveUrgency(b.status, b.last_action_date) }))
  .sort((x, y) => y.eff - x.eff || (y.b.last_action_date ?? '').localeCompare(x.b.last_action_date ?? ''))
  .slice(0, TOP_N)
  .map(({ b }) => b);

console.log(`coverage sync for top ${topBills.length} bills (PER_BILL=${PER_BILL})`);

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
  return merged;
}

let processed = 0;
for (const b of topBills) {
  const slug = slugOf(b);
  try {
    const candidates = await fetchArticles(queryFor(b), b.introduced_date ?? CONGRESS_START);
    if (candidates === null) break; // daily quota hit: stop and commit what we have
    anyFetchOk = true;
    const kept = await filterRelevant(b, candidates);
    processedSlugs.add(slug); // fresh result stands, even when empty
    if (kept.length) {
      out[slug] = kept;
      withCoverage++;
      totalArticles += kept.length;
    }
    console.log(`${slug}: ${candidates.length} candidates -> ${kept.length} kept`);
  } catch (e) {
    console.error(`FAIL ${slug}: ${e.message}`); // not processed — carries forward
  }
  // Checkpoint periodically so a long, rate-limited run never loses progress.
  if (++processed % 25 === 0) writeFileSync('data/coverage.json', JSON.stringify(withCarryForward()));
}

// Never clobber the existing file when the API never responded — preserve the
// current coverage (or the committed sample) and let the next run self-heal.
if (!anyFetchOk) {
  console.warn('No successful TheNewsAPI responses; leaving data/coverage.json unchanged.');
  process.exit(0);
}

const finalOut = withCarryForward();
const carried = Object.keys(finalOut).length - Object.keys(out).length;
finalOut._note = 'Generated by scripts/sync-coverage.mjs. Articles via TheNewsAPI; outlet lean is joined at render from data/media-bias.json (AllSides). Keys starting with "_" are metadata, ignored by getCoverage().';

writeFileSync('data/coverage.json', JSON.stringify(finalOut));
console.log(`DONE: ${withCoverage}/${topBills.length} bills with coverage, ${totalArticles} articles total${carried ? ` (+${carried} unprocessed bills carried forward)` : ''}`);
