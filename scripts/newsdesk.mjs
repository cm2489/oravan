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
 * ---- TIER-0 SOURCES: the government's own record (added 2026-07-23) ----
 * Before any press feed is consulted, four verified, free, zero-lean
 * Congress.gov/docs.house.gov signal feeds are ingested (all shapes
 * verified live 2026-07-23; parsers in newsdesk-match.mjs):
 *   house-floor-today.xml / senate-floor-today.xml - item title IS the
 *     bill number ("H.R.8884"); today's floor action, citation-grade.
 *   most-viewed-bills.xml - weekly single item; description is an <ol> of
 *     the top-10 with explicit numbers + congress tags; ONLY 119th-congress
 *     entries are accepted.
 *   docs.house.gov/billsthisweek/YYYYMMDD/YYYYMMDD.xml (Monday of the
 *     current week, US/Eastern) - the LOOK-AHEAD signal: bills scheduled
 *     days before the vote. A 404 just means no session week - clean no-op.
 * These fire WITHOUT the ≥2-outlet guardrail (they are the government's own
 * record, not press interpretation - no outlet lean exists to guard
 * against) and are logged loudly as TIER0 FIRE lines. They draw from their
 * own, higher decode caps (TIER0_DECODE_CAP/TIER0_DAILY_DECODE_CAP below).
 * This closed the 2026-07-23 gap where the week's biggest bills (NDAA
 * H.R.8800, the CR, the SAVE America Act) never triggered because
 * mainstream headlines use nicknames, not bill numbers.
 *
 * ---- PRESS SOURCES: free RSS only, no paid APIs ----
 * NEWS_API_KEY / TheNewsAPI is deliberately NOT used here — that quota
 * belongs to scripts/sync-coverage.mjs (which already exceeds its own
 * daily quota some nights; pipeline-audit.md §4). Politically-balanced
 * basket of 9 feeds (leans per data/media-bias.json), the original six
 * verified live 2026-07-16 and the three 2026-07-23 additions marked *:
 *   The Hill      thehill.com    center   https://thehill.com/homenews/feed/
 *   The Hill Senate* thehill.com center   https://thehill.com/homenews/senate/feed/
 *   The Hill House*  thehill.com center   https://thehill.com/homenews/house/feed/
 *                 (three feeds, ONE outlet: corroboration counts DISTINCT
 *                  outlet domains, so the Hill sub-feeds widen recall
 *                  without triple-counting thehill.com toward the
 *                  ≥2-outlet rule)
 *   Roll Call     rollcall.com   unrated  https://rollcall.com/feed/
 *                 (congress-focused trade pub, not AllSides-rated;
 *                  included for direct legislative signal, not lean
 *                  balance)
 *   NPR Politics  npr.org        center   https://feeds.npr.org/1014/rss.xml
 *   Fox News      foxnews.com    right    https://moxie.foxnews.com/google-publisher/politics.xml
 *   CBS News      cbsnews.com    left     https://www.cbsnews.com/latest/rss/politics
 *   Politico*     politico.com   left     https://rss.politico.com/congress.xml
 *   Google News   (per-article)  spans    https://news.google.com/rss/search?q=congress%20bill%20when:1d&hl=en-US&gl=US&ceid=US:en
 *                 many leans - each item carries a <source url="…"> tag
 *                 that resolves to a bare outlet domain, giving true
 *                 per-article outlet attribution from one aggregator feed.
 * Basket = 1 right + 2 left + 2 center outlets (Hill counted once) + 1
 * unrated congress trade pub + 1 cross-outlet aggregator, so no single
 * lean can structurally dominate which bills accumulate outlet
 * corroboration (see the ≥2-outlet rule below). Dead/rejected candidates
 * during verification: apnews.com/hub/politics.rss and apnews.com/rss
 * (both 404 — AP discontinued most public RSS), politico.com/rss/
 * politics08.xml (403; the congress.xml feed above works),
 * feeds.washingtonpost.com/rss/politics (200 but an empty/stub body).
 *
 * ---- Matching, cheapest first (full design in scripts/newsdesk-match.mjs) ----
 * t1 citation regex (free) -> t2 local token overlap against corpus
 * titles+press_names+news_query, rare tokens weighted double (free) -> t3
 * ONE batched claude-haiku-4-5-20251001 call for headlines t2 leaves
 * ambiguous, skipped entirely (zero API calls) when that batch is empty ->
 * nickname bridge: legislative-looking headlines t1/t2/t3 ALL missed get
 * their distinctive capitalized/quoted act-name tokens resolved against
 * ONE per-run Congress.gov recently-updated list (fetchRecentlyUpdated,
 * NICKNAME_LIST_LIMIT bills, fetched lazily and reused across headlines) —
 * the "brand-new big bill covered only by name" path. Bridge matches are
 * press-derived, so they still need ≥2-outlet corroboration.
 *
 * ---- Trigger rule (nonpartisan guardrail, non-negotiable) ----
 * A bill fires only if (a) extracted from a tier-0 GOVERNMENT feed (no
 * outlet lean exists, so no corroboration applies - logged loudly), (b)
 * matched by an explicit citation from ANY outlet, or (c) matched by
 * t2/t3/nickname-bridge and corroborated by >=2 DISTINCT outlets,
 * accumulated across runs via the seen-headlines cache (newsdesk-match.mjs's
 * decideFires; pending single-outlet holds expire after 7 days and are
 * summarized in every run's log). See that module's header comment for
 * why single-outlet triggering on a soft match would be a partisan-skew
 * prioritization channel that data/media-bias.json's display-only lean
 * normalization does nothing to prevent. Trigger sources must stay
 * lean-diverse (press) or lean-free (government) - never a single-lean
 * channel.
 *
 * ---- ON FIRE ----
 * Refresh the bill's status/last_action_date (free) via the SAME shared
 * syncOneBill (scripts/bill-decode.mjs) sync-bills.mjs uses. If the bill
 * is NOT already in the corpus — possible for a tier-0 extraction, a t1
 * citation match, or a nickname-bridge match; t2/t3 can only ever resolve
 * to a bill already in data/bills.json, by construction — decode it via
 * that same decode-before-publish path, force-bypassing the priority gate
 * (the trigger's own signal IS the worthiness gate here). Bounded by
 * per-run AND per-UTC-day caps in TWO separate budgets: press fires spend
 * NEWSDESK_DECODE_CAP/NEWSDESK_DAILY_DECODE_CAP, tier-0 government fires
 * spend their own higher TIER0_DECODE_CAP/TIER0_DAILY_DECODE_CAP (daily
 * counts persisted in the cache file) — see "Cost ceiling" below.
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
 * (~$0.70-1.50/day even then). Tier-0 government fires (2026-07-23) have
 * their own budget: TIER0_DECODE_CAP=6/run, TIER0_DAILY_DECODE_CAP=20/day.
 * On a typical day tier-0 adds ~$0: floor-scheduled bills are almost
 * always already in the corpus (free refresh); the daily cap only matters
 * in a black-swan week of brand-new floor bills, where the combined
 * code-enforced hard ceiling becomes 10+20=30 decodes ≈ $2.10-4.50 + the
 * ~$0.12 Haiku spend — still inside the owner's all-in <$5/day directive
 * at the very top of this header. The nickname bridge adds at most ONE
 * free Congress.gov list request per run and no LLM calls of its own. See
 * the introducing PRs' reports for the full typical/busy/hard-ceiling cost
 * tables.
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
import { fetchRecentlyUpdated, slugOf } from './congress-fetch.mjs';
import {
  anyDataChanged,
  buildBillIndex,
  buildListIndex,
  decideFires,
  extractBillsThisWeekSlugs,
  extractFloorFeedSlugs,
  extractMostViewedSlugs,
  extractNicknameTokens,
  findCitations,
  hashHeadline,
  looksLegislative,
  matchLocal,
  matchNickname,
  mondayOfWeekET,
  parseFeed,
  PENDING_OUTLETS_TTL_DAYS,
  prunePendingOutlets,
  summarizePendingOutlets,
} from './newsdesk-match.mjs';

// ---- Press-fire decode budget (unchanged from the 2026-07-16 design) ----
const NEWSDESK_DECODE_CAP = Number(process.env.NEWSDESK_DECODE_CAP ?? 3);
const NEWSDESK_DAILY_DECODE_CAP = Number(process.env.NEWSDESK_DAILY_DECODE_CAP ?? 10);
// ---- Tier-0 (government signal) decode budget ----
// Separate, slightly HIGHER caps than the press budget: tier-0 slugs come
// from the government's own floor schedules/most-viewed record — the
// highest-precision signal that exists — so a busy floor week must not
// starve behind the press caps, while both per-run and per-UTC-day bounds
// keep the black-swan ceiling code-enforced (header "Cost ceiling").
const TIER0_DECODE_CAP = Number(process.env.NEWSDESK_TIER0_DECODE_CAP ?? 6);
const TIER0_DAILY_DECODE_CAP = Number(process.env.NEWSDESK_TIER0_DAILY_DECODE_CAP ?? 20);
// The nickname bridge's ONE per-run Congress.gov list request: how many
// recently-updated bills to resolve extracted act-name tokens against.
// 100 ≈ several days of legislative motion — a brand-new bill big enough
// to be covered by nickname is essentially always inside this window.
const NICKNAME_LIST_LIMIT = Number(process.env.NEWSDESK_NICKNAME_LIST_LIMIT ?? 100);
const CACHE_DIR = process.env.NEWSDESK_CACHE_DIR ?? '.newsdesk-cache';
const CACHE_FILE = `${CACHE_DIR}/seen.json`;
const T3_MAX_HEADLINES = Number(process.env.NEWSDESK_T3_MAX_HEADLINES ?? 40);
const T3_MODEL = 'claude-haiku-4-5-20251001';
const USER_AGENT = 'Mozilla/5.0 (compatible; OravanNewsdesk/1.0; +https://oravan.org)';
// Congress.gov sits behind Cloudflare, which challenges bare-bones request
// UAs (plain curl is blocked); a normal browser-shaped UA passes the RSS
// endpoints cleanly (verified live 2026-07-23, along with the fact that
// the crawler-style USER_AGENT above ALSO currently passes — the explicit
// browser UA is used for tier-0 anyway so a future Cloudflare tightening
// against "compatible;" bot UAs can't silently kill the highest-precision
// signal).
const TIER0_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// See the header comment for the full basket rationale + verification
// dates. `domain` is what the ≥2-outlet rule counts, so the three Hill
// feeds deliberately share one domain (one outlet, wider recall).
const SOURCES = [
  { name: 'The Hill', domain: 'thehill.com', url: 'https://thehill.com/homenews/feed/' },
  { name: 'The Hill Senate', domain: 'thehill.com', url: 'https://thehill.com/homenews/senate/feed/' },
  { name: 'The Hill House', domain: 'thehill.com', url: 'https://thehill.com/homenews/house/feed/' },
  { name: 'Roll Call', domain: 'rollcall.com', url: 'https://rollcall.com/feed/' },
  { name: 'NPR Politics', domain: 'npr.org', url: 'https://feeds.npr.org/1014/rss.xml' },
  { name: 'Fox News Politics', domain: 'foxnews.com', url: 'https://moxie.foxnews.com/google-publisher/politics.xml' },
  { name: 'CBS News Politics', domain: 'cbsnews.com', url: 'https://www.cbsnews.com/latest/rss/politics' },
  { name: 'Politico Congress', domain: 'politico.com', url: 'https://rss.politico.com/congress.xml' },
  { name: 'Google News (congress bill query)', domain: null, url: 'https://news.google.com/rss/search?q=congress%20bill%20when:1d&hl=en-US&gl=US&ceid=US:en' },
];

// Tier-0 government signal feeds (header "TIER-0 SOURCES"). Each entry's
// extract() turns the raw body into citation-grade slugs; `weekly` marks
// the docs.house.gov look-ahead file whose 404 on a no-session week is a
// clean no-op, not an error.
const TIER0_SOURCES = [
  {
    label: 'house-floor-today',
    url: () => 'https://www.congress.gov/rss/house-floor-today.xml',
    extract: extractFloorFeedSlugs,
  },
  {
    label: 'senate-floor-today',
    url: () => 'https://www.congress.gov/rss/senate-floor-today.xml',
    extract: extractFloorFeedSlugs,
  },
  {
    label: 'most-viewed-bills',
    url: () => 'https://www.congress.gov/rss/most-viewed-bills.xml',
    extract: extractMostViewedSlugs,
  },
  {
    label: 'house-bills-this-week',
    url: () => {
      const monday = mondayOfWeekET();
      return `https://docs.house.gov/billsthisweek/${monday}/${monday}.xml`;
    },
    extract: extractBillsThisWeekSlugs,
    okOn404: true, // no session scheduled this week - nothing to look ahead to
  },
];

/** Fetch one tier-0 source and extract its slugs. Returns [] on an
 *  allowed 404; throws on anything else so Promise.allSettled surfaces it
 *  as a per-source failure without killing the run. */
async function fetchTier0(src) {
  const res = await fetch(src.url(), {
    signal: AbortSignal.timeout(20_000),
    headers: { 'User-Agent': TIER0_USER_AGENT },
  });
  if (res.status === 404 && src.okOn404) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return src.extract(await res.text());
}

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
    // pendingOutlets: slug -> { outlets: domain[], updated: ISO }. A cache
    // written by the pre-2026-07-23 shape (slug -> domain[]) is migrated in
    // place with `updated = now`, restarting its 7-day TTL - the safe
    // direction (a hold lives slightly longer once, never fires early).
    const pendingOutlets = {};
    for (const [slug, v] of Object.entries(raw.pendingOutlets ?? {})) {
      pendingOutlets[slug] = Array.isArray(v)
        ? { outlets: v, updated: new Date().toISOString() }
        : v;
    }
    return {
      seen: new Set(raw.seen ?? []),
      pendingOutlets,
      dailyDecodes: raw.dailyDecodes ?? null, // {date: 'YYYY-MM-DD', count, tier0Count}
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
  cache.dailyDecodes = { date: todayUTC, count: 0, tier0Count: 0 }; // roll over at UTC midnight
}
cache.dailyDecodes.tier0Count ??= 0; // cache written before the tier-0 budget existed

// ---- Tier-0: government signal feeds (fire without press corroboration) ----
// Dedupe key is (slug, UTC day), NOT the feed item title: the floor feeds
// republish the same bill numbers all day, and one refresh per bill per
// day is the intended cadence. Only the key's HASH enters the cache -
// never feed content (the never-republish rule).
const tier0SeenKey = (slug) => hashHeadline(`tier0:${slug}`, todayUTC);
console.log(`newsdesk tier-0: fetching ${TIER0_SOURCES.length} government signal feeds`);
const tier0Results = await Promise.allSettled(TIER0_SOURCES.map(fetchTier0));
const tier0Slugs = new Map(); // slug -> source label (first source to carry it wins)
tier0Results.forEach((r, i) => {
  const { label } = TIER0_SOURCES[i];
  if (r.status !== 'fulfilled') {
    console.error(`  tier-0 ${label} FAILED: ${r.reason?.message ?? r.reason}`);
    return;
  }
  const fresh = r.value.filter((slug) => !cache.seen.has(tier0SeenKey(slug)));
  console.log(`  tier-0 ${label}: ${r.value.length} bill(s), ${fresh.length} not yet handled today`);
  for (const slug of fresh) if (!tier0Slugs.has(slug)) tier0Slugs.set(slug, label);
});

console.log(`newsdesk: fetching ${SOURCES.length} press feeds`);
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
const localOutletsBySlug = new Map(); // this run's t2/t3/bridge outlet contributions, per slug
const bridgeItems = []; // legislative-looking headlines t1/t2 missed entirely - nickname-bridge input

const addLocalOutlet = (slug, it) => {
  if (!localOutletsBySlug.has(slug)) localOutletsBySlug.set(slug, new Set());
  localOutletsBySlug.get(slug).add(it.outlet ?? 'unknown');
};

for (const it of newItems) {
  const citations = findCitations(it.title);
  if (citations.length > 0) {
    for (const c of citations) citationSlugs.add(c.slug);
    continue; // citation tier wins outright - no need to also run t2/t3
  }
  const local = matchLocal(it.title, billIndex);
  if (local?.tier === 't2') {
    addLocalOutlet(local.slug, it);
  } else if (local?.tier === 'ambiguous' && looksLegislative(it.title) && t3Batch.length < T3_MAX_HEADLINES) {
    t3Batch.push({ title: it.title, candidates: local.candidates });
    t3Items.push(it);
  } else if (local === null && looksLegislative(it.title)) {
    // t2 can only ever resolve to a bill already in the corpus, by
    // construction - so a legislative-looking headline with NO local
    // signal at all is exactly the "brand-new big bill covered by name"
    // case. Hand it to the nickname bridge below.
    bridgeItems.push(it);
  }
  // else: not legislative-looking (dropped), or ambiguous beyond the t3
  // budget (dropped this run; fresh headlines next hour retry).
}

const t3Results = await resolveWithHaiku(anthropic, t3Batch);
console.log(`t3: ${t3Batch.length} headline(s) batched${t3Batch.length ? '' : ' (skipped - empty batch)'}, ${t3Results.size} resolved`);
t3Items.forEach((it, i) => {
  const slug = t3Results.get(i);
  if (slug) addLocalOutlet(slug, it);
  else bridgeItems.push(it); // t3 declined every candidate - last chance is the bridge
});

// ---- Nickname bridge: t1/t2/t3 all missed ----
// ONE lazy Congress.gov list request per run (skipped entirely when no
// headline needs it), reused across all bridge headlines - see the header.
// Bridge matches are press-derived and flow into the SAME
// localOutletsBySlug accumulator, so the >=2-outlet guardrail applies to
// them unchanged.
if (bridgeItems.length > 0) {
  try {
    const listIndex = buildListIndex(await fetchRecentlyUpdated(NICKNAME_LIST_LIMIT));
    let hits = 0;
    for (const it of bridgeItems) {
      const match = matchNickname(extractNicknameTokens(it.title), listIndex);
      if (match) {
        hits++;
        addLocalOutlet(match.slug, it);
      }
    }
    console.log(`nickname bridge: ${bridgeItems.length} headline(s) checked against ${listIndex.length} recently-updated bills, ${hits} matched`);
  } catch (e) {
    console.error(`nickname bridge skipped (list fetch failed): ${e.message}`);
  }
}

// Merge this run's t2/t3/bridge outlet contributions into the persisted
// pending state (stamping `updated` for the 7-day TTL), prune expired
// holds, THEN decide fires - corroboration accumulates across runs rather
// than resetting hourly (decideFires's header comment has the reasoning).
const nowISO = new Date().toISOString();
for (const [slug, outlets] of localOutletsBySlug) {
  const merged = new Set(cache.pendingOutlets[slug]?.outlets ?? []);
  for (const o of outlets) merged.add(o);
  cache.pendingOutlets[slug] = { outlets: [...merged], updated: nowISO };
}
const { kept, expired } = prunePendingOutlets(cache.pendingOutlets);
cache.pendingOutlets = kept;
if (expired.length > 0) {
  console.log(`pending holds expired unfired (>${PENDING_OUTLETS_TTL_DAYS}d without a 2nd outlet): ${expired.join(', ')}`);
}
console.log(summarizePendingOutlets(cache.pendingOutlets));
const pendingOutletsMap = new Map(
  Object.entries(cache.pendingOutlets).map(([slug, entry]) => [slug, new Set(entry.outlets)])
);
const { fired, reason } = decideFires(citationSlugs, pendingOutletsMap, tier0Slugs);
for (const [slug, label] of tier0Slugs) {
  // Loud by design: every guardrail bypass is individually visible in the
  // run log, with its government source named.
  console.log(`TIER0 FIRE: ${slug} <- ${label} (government record; bypasses the >=2-outlet press guardrail by design)`);
}
console.log(`fired this run: ${fired.size}${fired.size ? ' (' + [...fired].map((s) => `${s}:${reason.get(s)}`).join(', ') + ')' : ''}`);

// ---- ON FIRE: refresh (free) or decode (gated by per-budget caps) ----
// Two decode budgets, keyed off the fire reason: tier-0 government fires
// spend TIER0_*, everything press-derived spends NEWSDESK_*. decideFires
// lists tier-0 slugs first, so the highest-precision signal is never
// starved by a same-run press burst.
const forceSlugs = new Set(fired); // the trigger's own signal stands in for the status gate
const outcomes = [];
let pressDecodesThisRun = 0;
let tier0DecodesThisRun = 0;
for (const slug of fired) {
  const [type, number] = slug.split('-');
  const isTier0 = (reason.get(slug) ?? '').startsWith('tier0');
  const allowDecode = isTier0
    ? tier0DecodesThisRun < TIER0_DECODE_CAP && cache.dailyDecodes.tier0Count < TIER0_DAILY_DECODE_CAP
    : pressDecodesThisRun < NEWSDESK_DECODE_CAP && cache.dailyDecodes.count < NEWSDESK_DAILY_DECODE_CAP;
  const result = await syncOneBill({ type, number }, { allowDecode, forceSlugs, bills, es, bySlug, anthropic });
  outcomes.push(result.outcome);
  if (result.outcome === 'added') {
    if (isTier0) { tier0DecodesThisRun++; cache.dailyDecodes.tier0Count++; }
    else { pressDecodesThisRun++; cache.dailyDecodes.count++; }
  }
  if (result.outcome === 'refreshed' || result.outcome === 'added') {
    delete cache.pendingOutlets[slug]; // corroboration spent - a future re-fire needs fresh corroboration
  }
  if (isTier0) {
    // Mark the (slug, day) pair handled ONLY when the sync actually landed
    // (refreshed/added): a transient failure or a decode-cap 'budget'
    // deferral leaves the key unseen so the next hourly run retries, while
    // a handled bill won't re-fire from the same feeds until tomorrow.
    if (result.outcome === 'refreshed' || result.outcome === 'added') {
      cache.seen.add(tier0SeenKey(slug));
    }
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
