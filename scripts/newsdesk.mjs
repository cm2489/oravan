/**
 * Hourly headline-triggered bill resync (Part 2 of the 2026-07-16
 * spend-reduction pair; Part 1 is scripts/decode-gate.mjs +
 * scripts/sync-bills.mjs). Owner directive: a news-headline trigger with
 * ALL-IN cost under $5/day.
 *
 *   node --env-file=.env.local scripts/newsdesk.mjs
 *
 * Needs CONGRESS_API_KEY + ANTHROPIC_API_KEY.
 *
 * ---- SOURCES: free RSS only, no paid APIs ----
 * NEWS_API_KEY / TheNewsAPI is deliberately NOT used here — that quota
 * belongs to scripts/sync-coverage.mjs (which already exceeds its own
 * daily quota some nights; pipeline-audit.md §4). Politically-balanced
 * basket of 6 feeds (leans per data/media-bias.json), each verified live
 * 2026-07-16 to return parseable RSS/Atom with real items:
 *   The Hill      thehill.com    center   https://thehill.com/homenews/feed/
 *   Roll Call     rollcall.com   unrated  https://rollcall.com/feed/
 *                 (congress-focused trade pub, not AllSides-rated;
 *                  included for direct legislative signal, not lean
 *                  balance)
 *   NPR Politics  npr.org        center   https://feeds.npr.org/1014/rss.xml
 *   Fox News      foxnews.com    right    https://moxie.foxnews.com/google-publisher/politics.xml
 *   CBS News      cbsnews.com    left     https://www.cbsnews.com/latest/rss/politics
 *   Google News   (per-article)  spans    https://news.google.com/rss/search?q=congress%20bill%20when:1d&hl=en-US&gl=US&ceid=US:en
 *                 many leans - each item carries a <source url="…"> tag
 *                 that resolves to a bare outlet domain, giving true
 *                 per-article outlet attribution from one aggregator feed.
 * Basket = 1 right + 1 left + 2 center + 1 unrated congress trade pub + 1
 * cross-outlet aggregator, so no single lean can structurally dominate
 * which bills accumulate outlet corroboration (see the ≥2-outlet rule
 * below). Dead/rejected candidates during verification: apnews.com/hub/
 * politics.rss and apnews.com/rss (both 404 — AP discontinued most public
 * RSS), politico.com/rss/politics08.xml (403), feeds.washingtonpost.com/
 * rss/politics (200 but an empty/stub body).
 *
 * ---- Matching, cheapest first (full design in scripts/newsdesk-match.mjs) ----
 * t1 citation regex (free) -> t2 local token overlap against corpus
 * titles+press_names (free) -> t3 ONE batched claude-haiku-4-5-20251001
 * call for headlines t2 leaves ambiguous, skipped entirely (zero API
 * calls) when that batch is empty.
 *
 * ---- Trigger rule (nonpartisan guardrail, non-negotiable) ----
 * A bill fires only if (a) matched by an explicit citation from ANY
 * outlet, or (b) matched by t2/t3 and corroborated by >=2 DISTINCT
 * outlets, accumulated across runs via the seen-headlines cache
 * (newsdesk-match.mjs's decideFires). See that module's header comment for
 * why single-outlet triggering on a soft match would be a partisan-skew
 * prioritization channel that data/media-bias.json's display-only lean
 * normalization does nothing to prevent.
 *
 * ---- ON FIRE ----
 * Refresh the bill's status/last_action_date (free) via the SAME shared
 * syncOneBill (scripts/bill-decode.mjs) sync-bills.mjs uses. If the bill
 * is NOT already in the corpus — only possible for a t1 citation match;
 * t2/t3 can only ever resolve to a bill already in data/bills.json, by
 * construction — decode it via that same decode-before-publish path,
 * force-bypassing the priority gate (the press trigger's own corroboration
 * IS the worthiness signal here). Bounded by TWO caps: NEWSDESK_DECODE_CAP
 * per run and NEWSDESK_DAILY_DECODE_CAP per UTC day (persisted in the
 * cache file) — see "Cost ceiling" below for why both exist.
 *
 * ---- Dedupe (no hourly commits) ----
 * A seen-headlines cache (hash of normalized title+outlet) at
 * .newsdesk-cache/seen.json persists across runs via actions/cache in
 * newsdesk.yml — restored from the most recent previous run (a
 * restore-key prefix match) and always saved under a fresh run-scoped key,
 * so GitHub's own "evict caches unused for 7 days" policy ages out stale
 * state automatically with no TTL bookkeeping needed here. The same file
 * also carries `pendingOutlets` (the per-slug outlet sets the >=2-outlet
 * rule accumulates across runs) and `dailyDecodes` (the cost ceiling).
 * Cache miss (first run ever, an evicted cache, or a corrupt file)
 * degrades gracefully to empty state in loadCache(): a bill that's already
 * fresh just gets refreshed again (idempotent no-op), and an
 * already-decoded bill is never re-decoded (bySlug.has(slug) governs that,
 * not the cache).
 *
 * ---- Cost ceiling ----
 * Haiku (t3): most hourly runs' ambiguous batch is empty, so the LLM call
 * is skipped entirely (resolveWithHaiku) at $0; on an active-news hour a
 * ~20-40-headline batch at small prompts runs roughly $0.002-0.005/call.
 * Expected ~$0.12/day summed across 24 runs on a newsy day — an upper
 * estimate; many real days are lower. Trigger decodes (Sonnet 5,
 * ~$0.07-0.15/bill, same model/cost as sync-bills.mjs): a typical day
 * triggers 0 brand-new-bill decodes ($0, since a fired bill is almost
 * always already in the corpus and only needs a free refresh); a busy day
 * with 1-3 genuine new-bill triggers costs ~$0.07-0.45. The PER-RUN cap
 * (NEWSDESK_DECODE_CAP=3) alone does not bound the DAILY total — 24 runs x
 * 3 would allow up to ~$10.80/day in an implausible black-swan scenario —
 * so NEWSDESK_DAILY_DECODE_CAP=10 is a second, code-enforced ceiling
 * (~$0.70-1.50/day even then), keeping the documented "<$2/day" ceiling
 * true by construction rather than aspirational. See the introducing PR's
 * report for the full typical/busy/hard-ceiling cost table.
 *
 * ---- Boundaries ----
 * NEVER writes data/coverage.json — that stays scripts/sync-coverage.mjs's
 * (TheNewsAPI, display-only enrichment of already-known bills). A future
 * integration could have sync-coverage.mjs prioritize newsdesk-triggered
 * slugs first in its own urgency-ordered nightly queue; out of scope here.
 * Never touches data/sync-state.json's nightly cursor — same reasoning as
 * scripts/hot-bills.mjs: a same-day refresh/trigger pass is not the
 * nightly backlog scan's own progress signal.
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadJSON, syncOneBill } from './bill-decode.mjs';
import { slugOf } from './congress-fetch.mjs';
import {
  anyDataChanged,
  buildBillIndex,
  decideFires,
  findCitations,
  hashHeadline,
  looksLegislative,
  matchLocal,
  parseFeed,
} from './newsdesk-match.mjs';

const NEWSDESK_DECODE_CAP = Number(process.env.NEWSDESK_DECODE_CAP ?? 3);
const NEWSDESK_DAILY_DECODE_CAP = Number(process.env.NEWSDESK_DAILY_DECODE_CAP ?? 10);
const CACHE_DIR = process.env.NEWSDESK_CACHE_DIR ?? '.newsdesk-cache';
const CACHE_FILE = `${CACHE_DIR}/seen.json`;
const T3_MAX_HEADLINES = Number(process.env.NEWSDESK_T3_MAX_HEADLINES ?? 40);
const T3_MODEL = 'claude-haiku-4-5-20251001';
const USER_AGENT = 'Mozilla/5.0 (compatible; OravanNewsdesk/1.0; +https://oravan.org)';

// See the header comment for the full basket rationale + verification date.
const SOURCES = [
  { name: 'The Hill', domain: 'thehill.com', url: 'https://thehill.com/homenews/feed/' },
  { name: 'Roll Call', domain: 'rollcall.com', url: 'https://rollcall.com/feed/' },
  { name: 'NPR Politics', domain: 'npr.org', url: 'https://feeds.npr.org/1014/rss.xml' },
  { name: 'Fox News Politics', domain: 'foxnews.com', url: 'https://moxie.foxnews.com/google-publisher/politics.xml' },
  { name: 'CBS News Politics', domain: 'cbsnews.com', url: 'https://www.cbsnews.com/latest/rss/politics' },
  { name: 'Google News (congress bill query)', domain: null, url: 'https://news.google.com/rss/search?q=congress%20bill%20when:1d&hl=en-US&gl=US&ceid=US:en' },
];

async function fetchFeed(src) {
  const res = await fetch(src.url, {
    signal: AbortSignal.timeout(20_000),
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parseFeed(xml).map((it) => ({
    title: it.title,
    link: it.link,
    pubDate: it.pubDate,
    outlet: it.source ?? src.domain,
    feedName: src.name,
  }));
}

function loadCache() {
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    return {
      seen: new Set(raw.seen ?? []),
      pendingOutlets: raw.pendingOutlets ?? {}, // slug -> outlet domain[]
      dailyDecodes: raw.dailyDecodes ?? null, // {date: 'YYYY-MM-DD', count}
    };
  } catch {
    // Cache miss (first run, evicted, or corrupt) - degrade gracefully.
    // See the header comment: firing again on an already-handled bill is
    // idempotent, so losing this state costs a little redundant work, not
    // correctness.
    return { seen: new Set(), pendingOutlets: {}, dailyDecodes: null };
  }
}

function saveCache(cache) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify({
    seen: [...cache.seen],
    pendingOutlets: cache.pendingOutlets,
    dailyDecodes: cache.dailyDecodes,
  }));
}

/** ONE batched Haiku call resolving t2-ambiguous headlines against their
 *  own short candidate lists. Never trusts a slug the batch didn't offer -
 *  a hallucinated slug from the model can't enter the pipeline. */
async function resolveWithHaiku(anthropic, batch) {
  if (batch.length === 0) return new Map(); // skip t3 entirely - zero API calls
  const prompt = batch
    .map((b, i) => `${i}. HEADLINE: ${b.title}\n   CANDIDATES: ${b.candidates.map((c) => `${c.slug} = ${c.title}`).join(' | ')}`)
    .join('\n');
  let text;
  try {
    const msg = await anthropic.messages.create({
      model: T3_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: `For each numbered headline below, decide which ONE candidate bill (if any) it is actually reporting on. Only pick a candidate if the headline is clearly about that specific bill's provisions, vote, or status — not just a similar general topic. If none fit, use null.

${prompt}

Output STRICT JSON only, an array like [{"i":0,"slug":"hr-1234-119"},{"i":1,"slug":null}] — no prose, no markdown fences, no other text.` }],
    });
    text = msg.content[0]?.type === 'text' ? msg.content[0].text : '';
  } catch (e) {
    console.error(`t3 Haiku call failed: ${e.message}`);
    return new Map(); // degrade gracefully - no t3 matches this run
  }
  try {
    const jsonText = text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(jsonText);
    const out = new Map();
    for (const row of parsed) {
      if (row && typeof row.i === 'number' && typeof row.slug === 'string') {
        const validOffer = batch[row.i]?.candidates.some((c) => c.slug === row.slug);
        if (validOffer) out.set(row.i, row.slug);
      }
    }
    return out;
  } catch (e) {
    console.error(`t3 JSON parse failed: ${e.message}`);
    return new Map();
  }
}

// ---- main ----
const anthropic = new Anthropic({ maxRetries: 8 });
const bills = loadJSON('data/bills.json');
const es = loadJSON('data/bills-es.json');
const bySlug = new Map(bills.map((b) => [slugOf(b), b]));
const billIndex = buildBillIndex(bills);
const cache = loadCache();

const todayUTC = new Date().toISOString().slice(0, 10);
if (!cache.dailyDecodes || cache.dailyDecodes.date !== todayUTC) {
  cache.dailyDecodes = { date: todayUTC, count: 0 }; // roll over at UTC midnight
}

console.log(`newsdesk: fetching ${SOURCES.length} feeds`);
const results = await Promise.allSettled(SOURCES.map(fetchFeed));
const items = [];
results.forEach((r, i) => {
  if (r.status === 'fulfilled') {
    items.push(...r.value);
    console.log(`  ${SOURCES[i].name}: ${r.value.length} items`);
  } else {
    console.error(`  ${SOURCES[i].name} FAILED: ${r.reason?.message ?? r.reason}`);
  }
});

// Dedupe against the seen-headlines cache: skip anything already processed
// in a previous run (see the header comment's Dedupe section).
const newItems = items.filter((it) => !cache.seen.has(hashHeadline(it.title, it.outlet)));
console.log(`${items.length} headlines fetched, ${newItems.length} new (not previously seen)`);

const citationSlugs = new Set();
const t3Batch = [];
const t3Items = []; // parallel to t3Batch
const localOutletsBySlug = new Map(); // this run's t2/t3 outlet contributions, per slug

for (const it of newItems) {
  const citations = findCitations(it.title);
  if (citations.length > 0) {
    for (const c of citations) citationSlugs.add(c.slug);
    continue; // citation tier wins outright - no need to also run t2/t3
  }
  const local = matchLocal(it.title, billIndex);
  if (local?.tier === 't2') {
    if (!localOutletsBySlug.has(local.slug)) localOutletsBySlug.set(local.slug, new Set());
    localOutletsBySlug.get(local.slug).add(it.outlet ?? 'unknown');
  } else if (local?.tier === 'ambiguous' && looksLegislative(it.title) && t3Batch.length < T3_MAX_HEADLINES) {
    t3Batch.push({ title: it.title, candidates: local.candidates });
    t3Items.push(it);
  }
  // else: no local signal at all, or not legislative-looking - dropped.
  // t2/t3 can only ever resolve to a bill already in the corpus, by
  // construction (see newsdesk-match.mjs's header comment), so a headline
  // about a genuinely brand-new bill with no citation is unmatchable here.
}

const t3Results = await resolveWithHaiku(anthropic, t3Batch);
console.log(`t3: ${t3Batch.length} headline(s) batched${t3Batch.length ? '' : ' (skipped - empty batch)'}, ${t3Results.size} resolved`);
for (const [i, slug] of t3Results) {
  const it = t3Items[i];
  if (!localOutletsBySlug.has(slug)) localOutletsBySlug.set(slug, new Set());
  localOutletsBySlug.get(slug).add(it.outlet ?? 'unknown');
}

// Merge this run's t2/t3 outlet contributions into the persisted pending
// state, THEN decide fires - corroboration accumulates across runs rather
// than resetting hourly (decideFires's header comment has the reasoning).
for (const [slug, outlets] of localOutletsBySlug) {
  const merged = new Set(cache.pendingOutlets[slug] ?? []);
  for (const o of outlets) merged.add(o);
  cache.pendingOutlets[slug] = [...merged];
}
const pendingOutletsMap = new Map(
  Object.entries(cache.pendingOutlets).map(([slug, outlets]) => [slug, new Set(outlets)])
);
const { fired, reason } = decideFires(citationSlugs, pendingOutletsMap);
console.log(`fired this run: ${fired.size}${fired.size ? ' (' + [...fired].map((s) => `${s}:${reason.get(s)}`).join(', ') + ')' : ''}`);

// ---- ON FIRE: refresh (free) or decode (gated by both caps) ----
const forceSlugs = new Set(fired); // the press trigger's own corroboration stands in for the status gate
const outcomes = [];
let decodedThisRun = 0;
for (const slug of fired) {
  const [type, number] = slug.split('-');
  const allowDecode = decodedThisRun < NEWSDESK_DECODE_CAP && cache.dailyDecodes.count < NEWSDESK_DAILY_DECODE_CAP;
  const result = await syncOneBill({ type, number }, { allowDecode, forceSlugs, bills, es, bySlug, anthropic });
  outcomes.push(result.outcome);
  if (result.outcome === 'added') { decodedThisRun++; cache.dailyDecodes.count++; }
  if (result.outcome === 'refreshed' || result.outcome === 'added') {
    delete cache.pendingOutlets[slug]; // corroboration spent - a future re-fire needs fresh corroboration
  }
  console.log(`  ${slug}: ${result.outcome} (${reason.get(slug)})`);
}

// ---- persist: cache always, data files only if something actually changed ----
// Every headline this run touched (matched or not, fired or not) is marked
// seen so it isn't reprocessed next hour. The one accepted tradeoff: a
// citation-matched brand-new bill that hits BOTH decode caps this run
// ('budget' outcome) still gets its headline marked seen, so it won't
// retrigger from that exact article next hour - but a genuinely newsworthy
// bill almost always accumulates fresh headlines hour over hour, and even
// absent that, the nightly sync's own priority gate (scripts/decode-gate.mjs)
// will pick it up within a day once it has real recorded motion.
for (const it of newItems) cache.seen.add(hashHeadline(it.title, it.outlet));
saveCache(cache);

if (anyDataChanged(outcomes)) {
  writeFileSync('data/bills.json', JSON.stringify(bills));
  writeFileSync('data/bills-es.json', JSON.stringify(es));
  const refreshedCount = outcomes.filter((o) => o === 'refreshed').length;
  const addedCount = outcomes.filter((o) => o === 'added').length;
  console.log(`DONE: ${refreshedCount} refreshed, ${addedCount} added+decoded; corpus ${bills.length}`);
} else {
  console.log('DONE: no data changes this run - nothing written (the workflow commit step will no-op)');
}
