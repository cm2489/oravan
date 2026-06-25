/**
 * Nightly coverage sync. For the top-urgency band of bills, fetch real news
 * articles (TheNewsAPI), keep only the ones genuinely about the bill (a Haiku
 * relevance gate — the ONLY AI use here, and it authors nothing), and write
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rlRemaining = Infinity; // X-RateLimit-Remaining from the last response

const anthropic = new Anthropic({ maxRetries: 8 });
const MODEL = 'claude-haiku-4-5-20251001';

const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));

function slugOf(b) {
  return `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
}

/*
 * Read-time urgency — a copy of lib/data.ts so this script and the live site
 * agree on which bills are "top band". Keep in sync if lib/data.ts changes.
 */
const STATUS_BASE = {
  floor_vote: 0.9, passed_chamber: 0.75, conference: 0.75, markup: 0.65,
  committee: 0.45, signed: 0.3, vetoed: 0.3, introduced: 0.2,
};
const TERMINAL = new Set(['signed', 'vetoed']);

function effectiveUrgency(status, lastActionDate) {
  const base = STATUS_BASE[status] ?? 0.2;
  if (!lastActionDate) return base;
  const days = (Date.now() - new Date(lastActionDate).getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) return base;
  const bonus = days < 3 ? 0.1 : days < 7 ? 0.05 : 0;
  const decay = days <= 14 ? 0 : Math.min(0.45, (days - 14) * 0.015);
  return Math.max(0.05, Math.min(1, base + bonus - decay));
}

const topBills = bills
  .filter((b) => b.ai_headline && !TERMINAL.has(b.status))
  .map((b) => ({ b, eff: effectiveUrgency(b.status, b.last_action_date) }))
  .sort((x, y) => y.eff - x.eff || (y.b.last_action_date ?? '').localeCompare(x.b.last_action_date ?? ''))
  .slice(0, TOP_N)
  .map(({ b }) => b);

console.log(`coverage sync for top ${topBills.length} bills (PER_BILL=${PER_BILL})`);

/*
 * TheNewsAPI adapter — the ONLY provider-specific code. To swap providers,
 * reimplement this to return the same {title,url,source,snippet,publishedAt}
 * shape (source = bare outlet domain, e.g. "cnn.com"). Returns null on a
 * quota/rate signal so the caller can stop early and commit what it has.
 */
async function fetchArticles(query) {
  const url = new URL(NEWS_API);
  url.searchParams.set('api_token', NEWS_API_KEY);
  url.searchParams.set('search', query);
  url.searchParams.set('language', 'en');
  url.searchParams.set('limit', String(MAX_CANDIDATES));
  url.searchParams.set('sort', 'relevance_score');

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
        return (data.data ?? []).map((a) => ({
          title: a.title,
          url: a.url,
          source: a.source, // TheNewsAPI returns the bare domain
          snippet: a.description ?? a.snippet ?? null,
          publishedAt: a.published_at ? a.published_at.slice(0, 10) : null,
        }));
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

/* Search query from a bill: phrase-match its name (most precise) OR the citation. */
function queryFor(b) {
  const ident = `${b.bill_type.toUpperCase()} ${b.bill_number}`; // e.g. "HR 5582"
  const name = (b.short_title ?? b.title ?? '').trim();
  const usableName = name && name.length <= 80 && !/^an act|^a bill|^to /i.test(name);
  return usableName ? `"${name}" | "${ident}"` : `"${ident}"`;
}

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
let anyFetchOk = false;
let withCoverage = 0;
let totalArticles = 0;

let processed = 0;
for (const b of topBills) {
  const slug = slugOf(b);
  try {
    const candidates = await fetchArticles(queryFor(b));
    if (candidates === null) break; // daily quota hit: stop and commit what we have
    anyFetchOk = true;
    const kept = await filterRelevant(b, candidates);
    if (kept.length) {
      out[slug] = kept;
      withCoverage++;
      totalArticles += kept.length;
    }
    console.log(`${slug}: ${candidates.length} candidates -> ${kept.length} kept`);
  } catch (e) {
    console.error(`FAIL ${slug}: ${e.message}`);
  }
  // Checkpoint periodically so a long, rate-limited run never loses progress.
  if (++processed % 25 === 0) writeFileSync('data/coverage.json', JSON.stringify(out));
}

// Never clobber the existing file when the API never responded — preserve the
// current coverage (or the committed sample) and let the next run self-heal.
if (!anyFetchOk) {
  console.warn('No successful TheNewsAPI responses; leaving data/coverage.json unchanged.');
  process.exit(0);
}

out._note = 'Generated by scripts/sync-coverage.mjs. Articles via TheNewsAPI; outlet lean is joined at render from data/media-bias.json (AllSides). Keys starting with "_" are metadata, ignored by getCoverage().';

writeFileSync('data/coverage.json', JSON.stringify(out));
console.log(`DONE: ${withCoverage}/${topBills.length} bills with coverage, ${totalArticles} articles total`);
