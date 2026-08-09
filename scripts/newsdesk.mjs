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
 * Tier-0 refresh cadence is once per bill per FLOOR WINDOW (2026-08-08),
 * not once per bill per UTC day: Congress.gov publishes day D's floor
 * actions on D+1 between 13:35 and 14:00 UTC, so a single daily slot spent
 * by an early-morning run pushed that day's record to the next day. Three
 * windows - pre (00:00-13:59), record (14:00-18:59), session
 * (19:00-23:59) - each get their own slot; the measured evidence is in
 * newsdesk-match.mjs's floorBucket comment. This changes only how often a
 * FREE congress.gov refresh may happen; the decode budgets below are
 * per-run and per-UTC-day and are untouched by it.
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
 * t2/t3/nickname-bridge and corroborated by >=2 DISTINCT REAL outlets -
 * an article whose outlet can't be resolved to a domain (a Google News item
 * with a missing/unparseable <source url>) contributes its headline but NOT
 * corroboration, since counting it as a second newsroom let one outlet's
 * story corroborate itself (2026-08-09; countDistinctOutlets) -
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
 * rule accumulates across runs), `dailyDecodes` (the cost ceiling) and
 * `feedHealth` (the consecutive-darkness streak). The `seen` set holds three
 * namespaced key kinds, all hashes, never feed content: headline keys, tier-0
 * (slug, day, window) refresh slots, and failedDecodeKey holds for a slug
 * whose decode paid and failed today.
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
 * Both budgets are charged on the ATTEMPT, not the success (2026-08-09).
 * Until then only outcome 'added' was counted, so a decode that reached the
 * model and then threw — bill-decode.mjs's shape check rejecting a reply with
 * a missing tag, which is deterministic for a given verbose bill — spent two
 * Sonnet calls, charged the caps nothing, and left its slug unmarked, so the
 * same bill re-fired every hour for the rest of the day: unbounded paid
 * retries of a failure that could not succeed, right through a ceiling
 * described above as code-enforced. syncOneBill now reports `decodeAttempted`
 * and chargeableDecode charges on it; the free outcomes (refreshed, gated,
 * budget, and any failure before the first model call) never reach it. A slug
 * that paid and failed also gets a failedDecodeKey held for the rest of the
 * UTC day, so a deterministic failure costs at most one decode per day
 * instead of one per hour.
 *
 * ---- Failure visibility (2026-08-09) ----
 * Every feed here can throw, or serve a 200 with an empty/stub body, and the
 * run still exits 0 looking exactly like a quiet news hour — the shape that
 * would let a total ingest outage sit green for a week. So the run judges its
 * own intake (assessFeeds): all tier-0 feeds failing, or half the press
 * basket returning nothing, each emit a ::warning:: visible in the Actions
 * summary. A FULLY dark run (every tier-0 feed failed AND every press feed
 * silent — the only state that can't be an upstream coincidence) increments a
 * consecutive-darkness counter persisted in the same cache file, and at
 * FEED_DARK_ESCALATE_RUNS=6 in a row — six hours of receiving nothing at all —
 * the run emits ::error:: and exits 1. One caveat, stated where it bites: a
 * non-zero exit skips the newsdesk.yml steps after this script, including the
 * sibling Moment-updates collector. That is the intended trade at six hours
 * dark (a human is needed either way, and the collector is incremental — the
 * next healthy run re-collects), and nothing is lost from THIS script, which
 * by definition fired nothing and wrote nothing on a dark run.
 *
 * ---- Boundaries ----
 * NEVER writes data/coverage.json — that stays scripts/sync-coverage.mjs's
 * (TheNewsAPI, display-only enrichment of already-known bills). A future
 * integration could have sync-coverage.mjs prioritize newsdesk-triggered
 * slugs first in its own urgency-ordered nightly queue; out of scope here.
 * Never touches data/sync-state.json's nightly cursor — same reasoning as
 * scripts/hot-bills.mjs: a same-day refresh/trigger pass is not the
 * nightly backlog scan's own progress signal.
 * SIBLING STEP: scripts/moment-updates.mjs runs immediately after this one in
 * newsdesk.yml and owns data/moment-updates.json alone — it reads this
 * script's output (data/bills.json) and never writes anything this script
 * touches, so neither has to know about the other beyond this line.
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadJSON, syncOneBill } from './bill-decode.mjs';
import { fetchRecentlyUpdated, slugOf } from './congress-fetch.mjs';
import {
  anyDataChanged,
  assessFeeds,
  buildBillIndex,
  buildListIndex,
  chargeableDecode,
  decideFires,
  extractBillsThisWeekSlugs,
  extractFloorFeedSlugs,
  extractMostViewedSlugs,
  extractNicknameTokens,
  failedDecodeKey,
  FEED_DARK_ESCALATE_RUNS,
  findCitations,
  floorBucket,
  hashHeadline,
  looksLegislative,
  matchLocal,
  matchNickname,
  mondayOfWeekET,
  parseFeed,
  PENDING_OUTLETS_TTL_DAYS,
  prunePendingOutlets,
  rollDailyDecodes,
  rollFeedDarkness,
  summarizePendingOutlets,
  tier0SeenKey,
  UNRESOLVED_OUTLET,
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
      feedHealth: raw.feedHealth ?? null, // {consecutiveDark}
    };
  } catch {
    // Cache miss (first run, evicted, or corrupt) - degrade gracefully.
    // See the header comment: firing again on an already-handled bill is
    // idempotent, so losing this state costs a little redundant work, not
    // correctness.
    return { seen: new Set(), pendingOutlets: {}, dailyDecodes: null, feedHealth: null };
  }
}

function saveCache(cache) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify({
    seen: [...cache.seen],
    pendingOutlets: cache.pendingOutlets,
    dailyDecodes: cache.dailyDecodes,
    feedHealth: cache.feedHealth,
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
// Rolls at UTC midnight and at UTC midnight ONLY - never on a floor-window
// transition (rollDailyDecodes takes no window argument by construction).
// This is the cost invariant behind the three-window seen-key below.
cache.dailyDecodes = rollDailyDecodes(cache.dailyDecodes, todayUTC);

// ---- Tier-0: government signal feeds (fire without press corroboration) ----
// Dedupe key is (slug, UTC day, floor window), NOT the feed item title: the
// floor feeds republish the same bill numbers all day, so one refresh per
// bill per window is the intended cadence. Three windows rather than one
// per day because Congress.gov publishes day D's floor actions on D+1
// between 13:35 and 14:00 UTC - a single daily slot spent by an early
// morning run misses that day's record entirely. The measured evidence and
// the window boundaries are in newsdesk-match.mjs's floorBucket comment.
// The window is resolved ONCE here so a run that straddles a boundary
// spends and marks the same slot. Only the key's HASH enters the cache -
// never feed content (the never-republish rule).
const floorWindow = floorBucket();
const tier0Key = (slug) => tier0SeenKey(slug, todayUTC, floorWindow);
console.log(`newsdesk tier-0 [${floorWindow} window, ${todayUTC}]: fetching ${TIER0_SOURCES.length} government signal feeds`);
const tier0Results = await Promise.allSettled(TIER0_SOURCES.map(fetchTier0));
const tier0Slugs = new Map(); // slug -> source label (first source to carry it wins)
let tier0Failed = 0; // hard failures only - an empty floor feed is a recess day
tier0Results.forEach((r, i) => {
  const { label } = TIER0_SOURCES[i];
  if (r.status !== 'fulfilled') {
    tier0Failed++;
    console.error(`  tier-0 ${label} FAILED: ${r.reason?.message ?? r.reason}`);
    return;
  }
  const fresh = r.value.filter((slug) => !cache.seen.has(tier0Key(slug)));
  console.log(`  tier-0 ${label}: ${r.value.length} bill(s), ${fresh.length} not yet handled in the ${floorWindow} window`);
  for (const slug of fresh) if (!tier0Slugs.has(slug)) tier0Slugs.set(slug, label);
});

console.log(`newsdesk: fetching ${SOURCES.length} press feeds`);
const results = await Promise.allSettled(SOURCES.map(fetchFeed));
const items = [];
// "Silent" = threw OR returned zero items. The second half matters as much as
// the first: a 200 with an empty/stub body (the shape that killed
// feeds.washingtonpost.com's politics feed) never reaches Promise.allSettled's
// rejected branch and is indistinguishable from a quiet news hour unless it is
// counted here. A US-politics RSS feed with zero items is broken, not calm.
let pressSilent = 0;
results.forEach((r, i) => {
  if (r.status === 'fulfilled') {
    items.push(...r.value);
    if (r.value.length === 0) pressSilent++;
    console.log(`  ${SOURCES[i].name}: ${r.value.length} items${r.value.length === 0 ? ' (EMPTY - counted as silent)' : ''}`);
  } else {
    pressSilent++;
    console.error(`  ${SOURCES[i].name} FAILED: ${r.reason?.message ?? r.reason}`);
  }
});

// ---- the darkness tripwire ----------------------------------------------
// Every feed above can fail, or serve a stub body, and the run still walks to
// a clean exit 0 that reads exactly like an ordinary quiet hour - which is
// how a total ingest outage stays invisible behind a wall of green checks.
// Judge the intake, say so out loud, and persist a streak so a sustained
// blackout eventually reds the build (assessFeeds / rollFeedDarkness).
const health = assessFeeds({
  tier0Total: TIER0_SOURCES.length,
  tier0Failed,
  pressTotal: SOURCES.length,
  pressSilent,
});
if (health.tier0Dark) {
  console.log(`::warning::newsdesk: ALL ${TIER0_SOURCES.length} tier-0 government feeds failed this run - the highest-precision signal is dark (no floor schedule, no most-viewed, no look-ahead)`);
}
if (health.pressDegraded) {
  console.log(`::warning::newsdesk: ${pressSilent} of ${SOURCES.length} press feeds returned nothing (failed or empty body) - corroboration recall is degraded this run`);
}
cache.feedHealth = rollFeedDarkness(cache.feedHealth, health.dark);
if (health.dark) {
  console.log(`::warning::newsdesk: FULLY DARK run - zero tier-0 feeds and zero press items. Consecutive dark runs: ${cache.feedHealth.consecutiveDark}/${FEED_DARK_ESCALATE_RUNS}`);
}

// Dedupe against the seen-headlines cache: skip anything already processed
// in a previous run (see the header comment's Dedupe section).
const newItems = items.filter((it) => !cache.seen.has(hashHeadline(it.title, it.outlet)));
console.log(`${items.length} headlines fetched, ${newItems.length} new (not previously seen)`);

const citationSlugs = new Set();
const t3Batch = [];
const t3Items = []; // parallel to t3Batch
const localOutletsBySlug = new Map(); // this run's t2/t3/bridge outlet contributions, per slug
const bridgeItems = []; // legislative-looking headlines t1/t2 missed entirely - nickname-bridge input

// An article whose outlet can't be resolved to a real domain is still
// recorded - it is evidence, and its headline still has to be deduped - but
// it is filed under UNRESOLVED_OUTLET, which countDistinctOutlets refuses to
// count toward the >=2-outlet rule. Before 2026-08-09 it went in as the
// literal string 'unknown' and counted as a whole second newsroom, so one
// outlet's story arriving twice (its own feed, plus the same story as an
// unattributable Google News item) cleared a guardrail that exists to require
// two independent ones. See countDistinctOutlets in newsdesk-match.mjs.
const addLocalOutlet = (slug, it) => {
  if (!localOutletsBySlug.has(slug)) localOutletsBySlug.set(slug, new Set());
  localOutletsBySlug.get(slug).add(it.outlet ?? UNRESOLVED_OUTLET);
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
  // Per-slug daily backoff: this slug already paid for a decode today and the
  // decode failed. A failure inside decode() - the shape check rejecting a
  // reply with a missing tag - is deterministic for a given bill, so retrying
  // it this hour buys the same failure at the same price. Suppressing only
  // the DECODE (not the whole sync) keeps a free refresh available if the
  // bill reaches the corpus by some other path in the meantime.
  const decodeFailedToday = cache.seen.has(failedDecodeKey(slug, todayUTC));
  const allowDecode = !decodeFailedToday && (isTier0
    ? tier0DecodesThisRun < TIER0_DECODE_CAP && cache.dailyDecodes.tier0Count < TIER0_DAILY_DECODE_CAP
    : pressDecodesThisRun < NEWSDESK_DECODE_CAP && cache.dailyDecodes.count < NEWSDESK_DAILY_DECODE_CAP);
  const result = await syncOneBill({ type, number }, { allowDecode, forceSlugs, bills, es, bySlug, anthropic });
  outcomes.push(result.outcome);
  // Charged on the ATTEMPT, not the success: a decode that reached the model
  // and then threw spent exactly what a decode that landed spent. Before
  // 2026-08-09 only 'added' was charged, so a deterministic decode failure
  // cost the caps nothing and re-fired every hour, all day - unbounded paid
  // retries of something that could not succeed. The free outcomes
  // (refreshed/gated/budget, and a failure before the first model call) never
  // set decodeAttempted, so none of them can be charged. See chargeableDecode.
  if (chargeableDecode(result)) {
    if (isTier0) { tier0DecodesThisRun++; cache.dailyDecodes.tier0Count++; }
    else { pressDecodesThisRun++; cache.dailyDecodes.count++; }
    if (result.outcome !== 'added') {
      // Paid and failed - hold this slug's decode for the rest of the UTC day.
      cache.seen.add(failedDecodeKey(slug, todayUTC));
    }
  }
  if (result.outcome === 'refreshed' || result.outcome === 'added') {
    delete cache.pendingOutlets[slug]; // corroboration spent - a future re-fire needs fresh corroboration
  }
  if (isTier0) {
    // Mark the (slug, day, window) triple handled ONLY when the sync
    // actually landed (refreshed/added): a transient failure or a
    // decode-cap 'budget' deferral leaves the key unseen so the next hourly
    // run retries, while a handled bill won't re-fire from the same feeds
    // until the next floor window opens. Unchanged behavior per slot - the
    // slot is just no longer the whole day.
    if (result.outcome === 'refreshed' || result.outcome === 'added') {
      cache.seen.add(tier0Key(slug));
    }
  }
  const note = decodeFailedToday
    ? ' [decode suppressed: an earlier decode of this bill failed today - retries tomorrow]'
    : chargeableDecode(result) && result.outcome !== 'added'
      ? ' [decode attempted and failed - charged against the cap, held until tomorrow]'
      : '';
  console.log(`  ${slug}: ${result.outcome} (${reason.get(slug)})${note}`);
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

// LAST, and after saveCache: the streak has to survive the failure it causes,
// or the next run starts over at 1 and the build never actually reds. The
// workflow's cache-save step is `if: always()`, and the write above already
// happened, so both halves of that hold.
if (cache.feedHealth.escalate) {
  console.log(`::error::newsdesk has been fully dark for ${cache.feedHealth.consecutiveDark} consecutive hourly runs (>=${FEED_DARK_ESCALATE_RUNS}) - every tier-0 government feed failed and every press feed returned nothing, for ${cache.feedHealth.consecutiveDark} hours straight. This is an ingest outage, not a quiet news day: no bill can trigger a refresh or a decode while it lasts. Check network egress from the runner, then each feed URL in scripts/newsdesk.mjs's SOURCES/TIER0_SOURCES.`);
  process.exit(1);
}
