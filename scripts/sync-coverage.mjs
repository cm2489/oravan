/**
 * Nightly coverage sync. For up to COVERAGE_TOP_N requests' worth of eligible
 * bills a night (decoded and non-terminal, plus the exceptions
 * isCoverageEligible names; planCoverageRun picks which), fetch real news
 * articles (TheNewsAPI), keep only the ones genuinely about
 * the bill (a Haiku relevance gate — it authors nothing), and write
 * them to data/coverage.json keyed by bill slug. The render path joins each
 * article's source to an outlet lean from data/media-bias.json (AllSides).
 *
 * Since 2026-09-26 (see scripts/coverage-query.mjs, "The recency pass"): the
 * Big Question vehicles, the news-band pool and live tier-0 floor bills are
 * queried every night with an extra date-sorted 30-day pass; a night's result
 * MERGES into what is stored instead of replacing it; the relevance gate sees
 * dates; a newly enacted bill stays in the sweep for 14 days; and every stored
 * article records whether its outlet is AllSides-rated (`rated`), so the Read
 * section can later say "across the press" over rated outlets only. Follow-ups
 * the same week: the priority set is queried whatever its terminal status and
 * is capped at PRIORITY_MAX_SHARE of the night; a stored article tonight's gate
 * rejected is dropped; and the date pass's outlet mix is judged against the
 * whole-life pass every night (LEAN DRIFT), loudly when it shifts.
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { effectiveUrgency } from '../lib/urgency.mjs';
import { compareDocket, docketKey, docketRung } from '../lib/docket.mjs';
import { loadPressOutletPolicy } from '../lib/press-outlets.mjs';
import {
  DATE_SORT,
  PRIORITY_MAX_SHARE,
  RECENT_WINDOW_DAYS,
  RELEVANCE_SORT,
  apiErrorDetail,
  articleMatcher,
  coveragePriority,
  coverageSlug,
  formatLeanDrift,
  gateAnswered,
  isCoverageEligible,
  isNewestFirst,
  leanDrift,
  mergeArticles,
  parseKeptIndexes,
  planCoverageRun,
  queryFor,
  readRateLimitRemaining,
  recentWindowStart,
  relevancePrompt,
  wholeLifeStart,
  withoutRejected,
} from './coverage-query.mjs';

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
// The most of the night the priority set (two requests per bill) may take.
const PRIORITY_SHARE = envNum('COVERAGE_PRIORITY_SHARE', PRIORITY_MAX_SHARE);
// Bills processed concurrently. The loop was strictly sequential (one fetch +
// one Haiku call at a time), which is what made a wide sweep impractical on
// wall-clock rather than on cost. Keep this modest: TheNewsAPI rate-limits per
// 60s window and the pacing logic in fetchArticles is shared mutable state.
const CONCURRENCY = envNum('COVERAGE_CONCURRENCY', 6);
const NEWS_API = 'https://api.thenewsapi.com/v1/news/all';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rlRemaining = Infinity; // X-RateLimit-Remaining from the last response

const anthropic = new Anthropic({ maxRetries: 8 });
const MODEL = 'claude-haiku-4-5-20251001';

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
const bills = readJSON('data/bills.json');
const NOW = Date.now();

/* Tolerant reads: each of these builds the priority set, which decides who is
   asked first, who gets the extra 30-day pass, and (since the terminal-status
   bypass in isCoverageEligible) whether a terminal priority bill is in the
   sweep at all, and so whether its stored coverage is kept. A missing or
   unparseable file shrinks the priority set. For a signed Big Question
   vehicle like H.R. 6500 that means one night out of the sweep, and its stored
   coverage ages out of the file that night. It never fails the run. */
const readOptional = (p) => {
  try {
    return existsSync(p) ? readJSON(p) : null;
  } catch {
    console.warn(`coverage sync: ${p} unreadable — the priority set is built without it.`);
    return null;
  }
};

/* The outlet floor (lib/press-outlets.mjs). Used here only to RECORD, per
   article, whether its outlet is AllSides-rated — the fact the render path
   needs to say "across the press" over rated outlets alone. It filters nothing
   out of this file: what the Read section shows is the page's decision. */
const outletPolicy = loadPressOutletPolicy({ readJSON, exists: existsSync });
const withRatedFlag = (a) => ({ ...a, rated: outletPolicy.isRated(a?.source) });

// Last committed coverage. Eligible bills this run doesn't reach (quota stop,
// per-bill failure, or a COVERAGE_TOP_N test run) carry their previous entry
// forward, re-stamped with `rated` and otherwise unchanged. Bills the run DOES
// process merge tonight's kept articles into their stored ones (processBill):
// an empty night keeps what was stored, and the only stored articles a
// processed bill loses are ones pushed out by newer articles past PER_BILL, or
// ones tonight's gate was shown and rejected in a complete, well-formed reply.
let prevCoverage = {};
try {
  prevCoverage = JSON.parse(readFileSync('data/coverage.json', 'utf8'));
} catch {
  /* first run or unreadable file — nothing to carry forward */
}

const slugOf = coverageSlug;

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

/* THE HEAD IS THE LADDER (2026-08-12). It reads lib/docket.mjs — the same
   module, not a copy, that orders the live site — so this sweep and the site
   always agree about what is moving. It replaced a pure `effectiveUrgency`
   sort, which on a busy week returned a 0.95 tie block ordered by date alone
   and could not see a bill the chamber had ANNOUNCED for the floor at all
   (Congress overwrites the action text when a measure reaches the floor, and
   the derived status falls back to `committee` — the bills a reader is most
   likely to open tonight were the ones the old head key was blindest to).

   data/floor-signals.json is read tolerantly: this is the nightly coverage
   sweep, and a missing or unparseable signal file must degrade the ORDER, never
   fail the run. With no file every bill simply lands on a record-only rung. */
let floorSignalsDoc = null;
let floorSignals = {};
try {
  floorSignalsDoc = JSON.parse(readFileSync('data/floor-signals.json', 'utf8'));
  floorSignals = floorSignalsDoc.signals ?? {};
} catch {
  console.warn('coverage sync: data/floor-signals.json unreadable — ordering on the record alone.');
}

// `effectiveUrgency` stays as the TAIL's tiebreak (below): among bills nobody
// has looked at for the longest, the score is still the honest way to break a
// tie, and the tail is not a claim about the week.
//
// ELIGIBLE = decoded and not terminal, PLUS a signed bill for
// ENACTED_GRACE_DAYS after its last action (isCoverageEligible). The old
// filter dropped a bill the night it became law — exactly its peak coverage
// week (on the 2026-09-25 file, H.R. 5334, signed 09-18, had neither a check
// date nor any stored coverage).
//
// PLUS every bill in tonight's priority set, whatever its status (the
// `priority` option; 2026-09-26 follow-up): H.R. 6500 is still the funding
// question's vehicle 23 days after it became law, and the grace window alone
// had stopped checking it. The priority set is built FIRST for that reason.
const priorityInputs = coveragePriority({
  moments: readOptional('data/moments.json'),
  conversation: readOptional('data/conversation.json'),
  floorSignals: floorSignalsDoc,
  now: NOW,
});
const priorityWanted = new Set(priorityInputs.slugs);
const inSweep = (b) => isCoverageEligible(b, NOW, { priority: priorityWanted.has(slugOf(b)) });
const eligible = bills
  .filter(inSweep)
  .map((b) => {
    const slug = slugOf(b);
    const rung = docketRung(b, floorSignals[slug] ?? null, { now: NOW });
    return {
      b,
      eff: effectiveUrgency(b.status, b.last_action_date),
      key: docketKey({ slug, date: b.last_action_date, rung }),
    };
  })
  .sort((x, y) => compareDocket(x.key, y.key));

/* THE PRIORITY SET, THEN THE HEAD/TAIL SPLIT (planCoverageRun).

   Priority first: every live Big Question vehicle, every bill in the news
   band's C1/C2 pool, every bill with a live tier-0 floor signal. Those are the
   bills a reader is shown as "in the news" or as a Big Question, and on the
   corpus this was measured against (main, 2026-09-26 00:40Z) 21 of the 28
   eligible ones were not in that night's 600 at all — most Big Question
   vehicles were rechecked only every 9-10 days, by the rotating tail. Each
   priority bill costs TWO requests (a date-sorted 30-day pass beside the
   whole-life relevance pass), and the rotation below shrinks by exactly that
   much — the night still spends at most COVERAGE_TOP_N requests, the same
   quota as before. The priority set may take at most COVERAGE_PRIORITY_SHARE
   of the night (PRIORITY_MAX_SHARE, 20%); past that a priority bill is
   DEFERRED — no 30-day pass tonight, but still in line for a head/tail slot.

   Then, as before: the head is ladder order - what a reader is most likely to
   open tonight. The tail is whatever has gone longest without a look, oldest
   first, with never-checked bills sorted ahead of everything (empty string
   precedes any ISO date). A bill already claimed is never double-counted. */
const plan = planCoverageRun({
  ranked: eligible,
  prioritySlugs: priorityInputs.slugs,
  topN: TOP_N,
  tailShare: TAIL_SHARE,
  priorityShare: PRIORITY_SHARE,
  checkedAt,
});
const prioritySet = new Set(plan.priority.map(slugOf));
const { head, tail, overflow } = plan;
const topBills = [...plan.priority, ...head, ...tail, ...overflow];

console.log(
  `coverage sync: ${topBills.length} bills of ${eligible.length} eligible, ${plan.requests} requests planned of ${TOP_N} ` +
    `(${plan.priority.length} priority x2 [${priorityInputs.vehicles.length} Big Question vehicle(s), ` +
    `${priorityInputs.band.length} news-band, ${priorityInputs.tier0.length} tier-0] + ` +
    `${head.length} by docket rung + ${tail.length} least-recently-checked${overflow.length ? ` + ${overflow.length} overflow` : ''}), ` +
    `PER_BILL=${PER_BILL}, CONCURRENCY=${CONCURRENCY}`
);
if (plan.skipped.length) {
  console.log(`  priority slugs not in tonight's eligible set (undecoded, or not in the corpus): ${plan.skipped.join(', ')}`);
}
if (plan.deferred.length) {
  console.warn(
    `::warning::coverage sync: ${plan.deferred.length} priority bill(s) over the ${Math.round(PRIORITY_SHARE * 100)}% priority ceiling ` +
      `(${plan.maxPriority} bills of ${TOP_N} requests) get no ${RECENT_WINDOW_DAYS}-day pass tonight and compete for an ordinary slot: ` +
      `${plan.deferred.join(', ')}. Raise COVERAGE_PRIORITY_SHARE (or COVERAGE_TOP_N) if this persists.`
  );
}

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
 *
 * `sort` is RELEVANCE_SORT for the whole-life pass, DATE_SORT for the 30-day
 * pass, or null to send no sort at all (the API's default order). A 400 or 422
 * is a request the API will never accept, so it is NOT retried (six retries
 * would spend six more requests of the night's budget on a certain refusal):
 * it throws at once with the status and the API's own error detail attached,
 * which is how fetchRecent tells a rejected sort value from a bad query.
 * Nothing here ever logs the request URL — it carries the API token.
 */
async function fetchArticles(query, { publishedAfter, sort }) {
  const url = new URL(NEWS_API);
  url.searchParams.set('api_token', NEWS_API_KEY);
  url.searchParams.set('search', query);
  url.searchParams.set('language', 'en');
  url.searchParams.set('locale', 'us'); // US outlets only - US bills, AllSides-rated world
  url.searchParams.set('limit', String(MAX_CANDIDATES));
  if (sort) url.searchParams.set('sort', sort);
  if (publishedAfter) url.searchParams.set('published_after', publishedAfter); // coverage can't predate the bill

  let lastErr;
  for (let attempt = 0; attempt <= 6; attempt++) {
    // Proactive throttle: if this 60s window's budget is spent, wait it out
    // rather than firing a request we know will 429.
    if (rlRemaining <= 0) { console.log('  rate budget spent — waiting 60s for the window to reset'); await sleep(60_000); rlRemaining = Infinity; }
    else if (attempt > 0) await sleep(2000 * attempt);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      // Only honor the header when it actually said something. A MISSING
      // header used to read as `Number(null)` === 0 — finite, so it latched
      // rlRemaining to "budget spent" and made every later batch sleep 60s
      // before firing, permanently. readRateLimitRemaining returns null for
      // absent/blank/non-numeric and we leave the estimate untouched.
      const rem = readRateLimitRemaining(res.headers);
      if (rem !== null) rlRemaining = rem;
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
      if (res.status === 400 || res.status === 422) {
        const body = await res.json().catch(() => ({}));
        const detail = apiErrorDetail(body);
        const err = new Error(`TheNewsAPI ${res.status} (${detail})`);
        err.status = res.status;
        err.detail = detail;
        throw err;
      }
      lastErr = new Error(`TheNewsAPI ${res.status}`);
    } catch (e) {
      if (e?.status === 400 || e?.status === 422) throw e; // a refusal, not a blip
      lastErr = e; // network error / timeout — retry
    }
  }
  throw lastErr ?? new Error('TheNewsAPI: exhausted retries');
}

/* Search query construction lives in scripts/coverage-query.mjs (shared with
   the eval harness and pinned by tests/coverage-query.unit.spec.ts). */

/* Haiku relevance gate: keep only articles specifically about THIS bill. The
   prompt (relevancePrompt) shows each article's date and the bill's own dates.
   It returns every kept article; the PER_BILL cap is applied AFTER the merge
   with what is stored (mergeArticles), newest first — so the cap chooses by
   date, not by the order the search happened to return.

   It also returns what the gate REJECTED, and whether the reply was a
   complete, well-formed answer (gateAnswered: the model finished, one text
   block, and exactly "none" or a comma-separated list of in-range indexes).
   processBill drops a stored article the gate was shown and rejected
   tonight ONLY on such a reply. Any other reply rejects nothing, so it can
   never delete stored coverage. What a reply KEEPS is read as it always has
   been (parseKeptIndexes, any in-range number in the reply), so tightening
   the drop rule did not change what a night adds. */
async function filterRelevant(b, candidates) {
  if (candidates.length === 0) return { kept: [], rejected: [], answered: false };
  const msg = await anthropic.messages.create({
    model: MODEL,
    // Room for every index when a priority bill brings two passes' worth of
    // candidates (up to 2 x MAX_CANDIDATES); output is billed as written.
    max_tokens: Math.max(80, 4 * candidates.length),
    messages: [{ role: 'user', content: relevancePrompt(b, candidates) }],
  });
  const text = msg.content[0]?.type === 'text' ? msg.content[0].text : '';
  const keep = parseKeptIndexes(text, candidates.length);
  const answered =
    Array.isArray(msg.content) &&
    msg.content.length === 1 &&
    gateAnswered(text, candidates.length, { stopReason: msg.stop_reason });
  return {
    kept: candidates.filter((_, i) => keep.has(i)),
    rejected: answered ? candidates.filter((_, i) => !keep.has(i)) : [],
    answered,
  };
}

// ---- main ----
const out = {};
const processedSlugs = new Set();
let anyFetchOk = false;
let withCoverage = 0;
let totalArticles = 0;
/* What TONIGHT found, apart from what was already stored. The DONE line's
   stored counts include carried-over articles, so an empty night (an API that
   answers with no articles, a gate that keeps nothing) would otherwise read
   like a normal one. An API that answers NOTHING at all never reaches the DONE
   line; it prints the COVERAGE OUTAGE line instead (below the batch loop). */
let keptTonight = 0;
let billsKeptTonight = 0;
let droppedOnVerdict = 0;
/* Stored articles that tonight's gate was shown again with a complete,
   well-formed reply, which means their earlier verdict was up for review.
   This is the denominator for the mass-drop alarm: droppedOnVerdict can never
   exceed it. */
let rejudgedStored = 0;
let unansweredGates = 0;
/* Bills whose news request or gate call threw (a FAIL line), and whether the
   daily quota stopped the run. Used only by the COVERAGE OUTAGE line. */
let failedBills = 0;
let quotaStopped = false;

/* The date-sorted pass's bookkeeping — printed as the DATE PASS summary, which
   is how the first nightly after 2026-09-26 verifies DATE_SORT against the live
   API (see its comment in scripts/coverage-query.mjs). `dateSort` flips to null
   for the rest of the run the first time the API refuses the value; the 30-day
   pass then continues in the API's default order, still recency-bounded. */
let dateSort = DATE_SORT;
const datePass = { sent: 0, unsorted: 0, ordered: 0, disordered: 0, rejected: null, recentKept: 0 };

/* NONPARTISAN BY CONSTRUCTION means a change to how the source is asked must
   be MEASURED by lean, not assumed neutral. The 30-day pass asks TheNewsAPI a
   different question (newest, not most relevant), and whether that shifts the
   outlet mix could not be measured without a keyed call — so every night
   measures it: what the gate kept, split by which pass returned it and by the
   outlet's AllSides lean. The whole-life pass on the same priority bills is the
   control. Each pass is counted on its own — an article both passes returned
   counts in both — so the two columns are what each QUESTION yields after the
   gate, not a split of one pile. Printed as the LEAN MIX line, judged by
   leanDrift (scripts/coverage-query.mjs) as the LEAN DRIFT line, and a shift
   past its thresholds is a ::warning:: that lib/pipeline-health.mjs raises to
   a ⛔ in the daily digest. */
const leanMix = () => ({ left: 0, center: 0, right: 0, unrated: 0 });
const keptLean = { recent: leanMix(), wholeLife: leanMix(), rest: leanMix() };
const tallyLean = (bucket, articles) => {
  for (const a of articles) bucket[outletPolicy.leanOf(a?.source) ?? 'unrated']++;
};
const fmtMix = (m) => `L${m.left}/C${m.center}/R${m.right}/unrated ${m.unrated}`;

/* Fresh results plus previous coverage for still-eligible bills not (yet)
   processed this run — whether unreached (quota stop), failed, or outside a
   COVERAGE_TOP_N selection. Used for every write so neither a checkpoint
   file nor a partial final write can drop an unprocessed bill's coverage.
   Entries for bills that went terminal (or left the corpus, or passed the
   enacted grace window) still age out — unless the bill is in tonight's
   priority set, which keeps it in the sweep (isCoverageEligible).

   Every article written carries `rated` — whether its outlet is AllSides-rated
   at write time — including carried-forward ones, so the whole file speaks
   the same shape after one night. */
const eligibleSlugs = new Set(bills.filter(inSweep).map(slugOf));
function withCarryForward() {
  const merged = {};
  for (const [slug, arts] of Object.entries(out)) merged[slug] = arts.map(withRatedFlag);
  for (const [slug, arts] of Object.entries(prevCoverage)) {
    if (slug.startsWith('_') || processedSlugs.has(slug)) continue;
    if (eligibleSlugs.has(slug) && Array.isArray(arts) && arts.length) {
      merged[slug] = arts.map(withRatedFlag);
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

/* The 30-day pass for one priority bill. Returns the candidates, null on a
   quota stop, or throws like fetchArticles. A 400/422 while DATE_SORT is being
   sent is PROBED rather than trusted: the same request goes again with no sort.
   If that succeeds, the sort value was the problem — say so loudly, once, and
   stop sending it; if it fails too, the query was the problem and the error
   propagates as an ordinary per-bill failure. */
async function fetchRecent(b, query) {
  const publishedAfter = recentWindowStart(b, NOW);
  if (!dateSort) {
    datePass.unsorted++;
    return fetchArticles(query, { publishedAfter, sort: null });
  }
  try {
    datePass.sent++;
    const res = await fetchArticles(query, { publishedAfter, sort: dateSort });
    if (res) {
      const order = isNewestFirst(res);
      if (order === true) datePass.ordered++;
      if (order === false) datePass.disordered++;
    }
    return res;
  } catch (e) {
    if (e?.status !== 400 && e?.status !== 422) throw e;
    datePass.unsorted++;
    const res = await fetchArticles(query, { publishedAfter, sort: null }); // throws if the query itself is bad
    if (dateSort) {
      datePass.rejected = `HTTP ${e.status}: ${e.detail}`;
      console.warn(
        `::warning::coverage sync: TheNewsAPI REJECTED sort=${dateSort} (HTTP ${e.status}: ${e.detail}). ` +
          `The same request without a sort succeeded, so the value is the problem — fix DATE_SORT in scripts/coverage-query.mjs. ` +
          `The ${RECENT_WINDOW_DAYS}-day pass continues for the rest of this run in the API's default order (still limited to the last ${RECENT_WINDOW_DAYS} days).`
      );
      dateSort = null;
    }
    return res;
  }
}

/* One bill, start to finish. Returns 'quota' when TheNewsAPI signals the daily
   ceiling so the caller can stop the whole run; 'ok' or 'fail' otherwise. A
   FAILED bill is deliberately NOT marked checked - it carries its old coverage
   forward AND stays at the front of tomorrow's tail, so a transient error can
   never quietly retire a bill from rotation.

   A priority bill makes two requests (the 30-day pass first, then the
   whole-life relevance pass) and ONE gate call over both candidate lists.
   Every processed bill's kept articles MERGE into what was stored — by URL,
   newest first, capped at PER_BILL — so an empty or unlucky night keeps what
   an earlier night found instead of erasing it. The one exception is an
   article the gate was SHOWN tonight and rejected: that verdict replaces the
   earlier one (withoutRejected), and only when the reply was a complete,
   well-formed answer (gateAnswered). */
async function processBill(b) {
  const slug = slugOf(b);
  const query = queryFor(b);
  const isPriority = prioritySet.has(slug);
  try {
    let recent = [];
    if (isPriority) {
      recent = await fetchRecent(b, query);
      if (recent === null) return 'quota';
      anyFetchOk = true;
    }
    const whole = await fetchArticles(query, { publishedAfter: wholeLifeStart(b), sort: RELEVANCE_SORT });
    if (whole === null) return 'quota';
    anyFetchOk = true;
    const candidates = dedupeArticles([...recent, ...whole]);
    const { kept, rejected, answered } = await filterRelevant(b, candidates);
    processedSlugs.add(slug);
    checkedAt[slug] = RUN_DAY; // looked at tonight, regardless of what we found
    const noAnswer = candidates.length > 0 && !answered;
    if (noAnswer) unansweredGates++;
    keptTonight += kept.length;
    if (kept.length) billsKeptTonight++;
    const keptRecent = kept.filter(articleMatcher(recent));
    datePass.recentKept += keptRecent.length;
    if (isPriority) {
      tallyLean(keptLean.recent, keptRecent);
      tallyLean(keptLean.wholeLife, kept.filter(articleMatcher(whole)));
    } else {
      tallyLean(keptLean.rest, kept);
    }
    const storedBefore = Array.isArray(prevCoverage[slug]) ? prevCoverage[slug] : [];
    if (answered) rejudgedStored += storedBefore.filter(articleMatcher(candidates)).length;
    const stored = withoutRejected(storedBefore, rejected);
    const dropped = storedBefore.length - stored.length;
    droppedOnVerdict += dropped;
    const merged = mergeArticles(kept, stored, PER_BILL);
    if (merged.length) {
      out[slug] = merged;
      withCoverage++;
      totalArticles += merged.length;
    }
    console.log(
      `${slug}: ${candidates.length} candidates` +
        `${isPriority ? ` (${recent.length} from the ${RECENT_WINDOW_DAYS}-day pass)` : ''}` +
        ` -> ${kept.length} kept` +
        `${dropped ? `, ${dropped} stored article(s) dropped on tonight's gate verdict` : ''}` +
        `${noAnswer ? " (the gate's reply was not complete and well-formed: no stored article dropped)" : ''}` +
        ` -> ${merged.length} stored`
    );
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
  failedBills += results.filter((r) => r === 'fail').length;
  // Checkpoint per batch so a long, rate-limited run never loses progress —
  // but only once the API has answered at least once. Before that there is
  // nothing to keep, and a checkpoint would still rewrite the file (aging out
  // entries, re-stamping `rated`, dropping `_note`), so the outage exit below
  // could not honestly say the file was left unchanged.
  if (anyFetchOk) writeFileSync('data/coverage.json', JSON.stringify(withCarryForward()));

  if (results.includes('quota')) {
    quotaStopped = true;
    console.error(`TheNewsAPI daily quota exhausted after ${processed} bills — stopping early`);
    break;
  }
}

/* THE OUTAGE LINE. When TheNewsAPI never answered, the run keeps the committed
   file exactly as it was (nothing above wrote it) and exits 0, so the rest of
   the nightly still lands. It also exits BEFORE the DONE line, so
   pipeline-health's coverage-kept-zero alarm, which reads the DONE line, never
   saw a hard outage. It now reads this line instead, as the coverage-outage
   ⛔ (lib/pipeline-health.mjs parseCoverageOutage). The wording is a contract
   with that parser. tests/sync-coverage-runner.unit.spec.ts feeds this
   script's real output to it. */
if (!anyFetchOk) {
  if (topBills.length === 0) {
    console.warn('coverage sync: no eligible bill was planned tonight, so nothing was asked; data/coverage.json left unchanged.');
    process.exit(0);
  }
  const outage =
    `COVERAGE OUTAGE: 0 of ${topBills.length} planned bill(s) got a TheNewsAPI response tonight ` +
    `(${failedBills} failed${quotaStopped ? '; the daily quota stopped the run' : ''}) — data/coverage.json left unchanged, no bill checked`;
  console.log(outage);
  console.warn(
    `::warning::coverage sync: TheNewsAPI answered none of tonight's requests (${failedBills} bill(s) failed` +
      `${quotaStopped ? '; the daily quota stopped the run' : ''}). No bill was checked and data/coverage.json is unchanged — see the FAIL lines above.`
  );
  process.exit(0);
}

const finalOut = withCarryForward();
// Count bills only — withCarryForward() also sets the "_checkedAt" metadata key,
// which would otherwise show up as one phantom carried-forward bill.
const carried =
  Object.keys(finalOut).filter((k) => !k.startsWith('_')).length - Object.keys(out).length;
finalOut._note = 'Generated by scripts/sync-coverage.mjs. Articles via TheNewsAPI; outlet lean is joined at render from data/media-bias.json (AllSides). Each article\'s "rated" records whether its outlet was AllSides-rated when it was written. Keys starting with "_" are metadata, ignored by getCoverage().';

writeFileSync('data/coverage.json', JSON.stringify(finalOut));
/* Staleness is now measurable, so print it: this is the number that went
   unwatched until 2026-08-05 and the one to check after a wide refresh. */
const staleDays = (iso) => Math.round((Date.now() - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000);
const coveredSlugs = Object.keys(finalOut).filter((k) => !k.startsWith('_'));
const ages = coveredSlugs.map((slug) => (finalOut._checkedAt[slug] ? staleDays(finalOut._checkedAt[slug]) : Infinity));
const neverChecked = ages.filter((d) => d === Infinity).length;
const over30 = ages.filter((d) => d !== Infinity && d > 30).length;
/* The number the recency pass exists to move (86.2% over 30 days, median 116,
   on the 2026-09-25 corpus): how old each covered bill's NEWEST article is. */
const newestAges = coveredSlugs
  .map((slug) => finalOut[slug].map((a) => a.publishedAt).filter(Boolean).sort().pop())
  .filter(Boolean)
  .map(staleDays)
  .sort((a, b) => a - b);
const median = newestAges.length ? newestAges[Math.floor(newestAges.length / 2)] : null;
const staleShare = newestAges.length
  ? ((100 * newestAges.filter((d) => d > 30).length) / newestAges.length).toFixed(1)
  : '0.0';

/* The DONE line. Its first half is the shape lib/pipeline-health.mjs's
   parseCoverageDone has always read (so older logs still parse); since the
   merge, those counts include articles carried over from earlier nights, so
   the second half says what TONIGHT found. An empty night now reads
   "kept tonight: 0 article(s) on 0 bill(s)" instead of passing for normal.
   "D of J re-judged" is how many stored articles tonight's gate dropped, out
   of how many it was shown again with a complete, well-formed reply. The pair
   is what pipeline-health's coverage-mass-drop alarm reads. The wording is a
   contract with parseCoverageDone. */
console.log(
  `DONE: ${withCoverage}/${topBills.length} bills with coverage, ${totalArticles} articles total` +
    `${carried ? ` (+${carried} unprocessed bills carried forward)` : ''}` +
    `; kept tonight: ${keptTonight} article(s) on ${billsKeptTonight} bill(s)` +
    `; ${droppedOnVerdict} of ${rejudgedStored} re-judged stored article(s) dropped on tonight's gate verdict` +
    `; ${unansweredGates} gate reply(ies) not complete and well-formed (no stored article dropped on them)`
);
console.log(
  `FRESHNESS: ${ages.length - neverChecked - over30} checked within 30d, ` +
    `${over30} older than 30d, ${neverChecked} never checked`
);
console.log(
  `ARTICLE AGE: newest stored article is older than 30d for ${staleShare}% of covered bills ` +
    `(median ${median ?? 'n/a'} days, ${newestAges.length} dated bills)`
);
console.log(
  `DATE PASS: sort=${DATE_SORT} sent on ${datePass.sent} request(s); ${datePass.ordered} came back newest-first, ` +
    `${datePass.disordered} did not (responses with 2+ dated articles only); ${datePass.unsorted} sent without a sort; ` +
    `${datePass.recentKept} kept article(s) came from the ${RECENT_WINDOW_DAYS}-day pass` +
    `${datePass.rejected ? `; REJECTED: ${datePass.rejected}` : ''}`
);
console.log(
  `LEAN MIX (kept tonight, AllSides): priority bills — ${RECENT_WINDOW_DAYS}-day pass ${fmtMix(keptLean.recent)}, ` +
    `whole-life pass ${fmtMix(keptLean.wholeLife)}; all other bills ${fmtMix(keptLean.rest)}`
);
const drift = leanDrift(keptLean.recent, keptLean.wholeLife);
const driftLine = formatLeanDrift(drift, RECENT_WINDOW_DAYS);
console.log(`LEAN DRIFT: ${driftLine}`);
if (drift.verdict === 'drift') {
  console.warn(
    `::warning::coverage sync: LEAN DRIFT — the ${RECENT_WINDOW_DAYS}-day date-sorted pass kept a different outlet mix than ` +
      `the whole-life pass on the same priority bills (${driftLine}). Nonpartisan by construction: a change to how the ` +
      `source is asked is measured by lean — read tonight's per-bill lines before keeping DATE_SORT as it is.`
  );
}
if (datePass.disordered > 0) {
  console.warn(
    `::warning::coverage sync: ${datePass.disordered} response(s) sent with sort=${DATE_SORT} were NOT newest-first — ` +
      `the API may be accepting the value but ignoring it. The ${RECENT_WINDOW_DAYS}-day window still applies; check DATE_SORT in scripts/coverage-query.mjs.`
  );
}
