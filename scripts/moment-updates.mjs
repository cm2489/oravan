/**
 * The Moments v2 live-layer collector — writes data/moment-updates.json
 * (the project records §5–§6).
 *
 *   MOMENT_UPDATES_MODE=incremental node --env-file=.env.local scripts/moment-updates.mjs   # hourly, in newsdesk.yml
 *   MOMENT_UPDATES_MODE=nightly     node --env-file=.env.local scripts/moment-updates.mjs   # nightly, in sync-bills.yml
 *
 * WHAT THE MODE ACTUALLY SELECTS, because both modes commit and deploy this
 * file and the difference is easy to over-read: `nightly` additionally
 * collects press clusters and writes state summaries (the two steps that cost
 * money and that only make sense once a day). EVERYTHING ELSE runs in both —
 * collection, the lint, the merge, and **the storage envelopes**. The prune
 * used to be nightly-only, which left HARD_DAY_CEILING and
 * MAX_UPDATES_PER_MOMENT unenforced on 24 of the day's 25 writes; see the
 * prune loop in main() for what that cost (2026-08-09).
 *
 * Needs CONGRESS_API_KEY. ANTHROPIC_API_KEY is optional — without it the
 * decode and summary steps are skipped and every update carries the verbatim
 * government record with `ai: false`.
 *
 * Pure mapping logic lives in scripts/moment-updates-map.mjs (network-free, so
 * tests/moment-updates-collect.unit.spec.ts can exercise the whole selection
 * design with zero mocking) — the same split as scripts/newsdesk.mjs /
 * scripts/newsdesk-match.mjs. This file does the I/O, the ceilings, the LLM
 * calls, and the write.
 *
 * ---------------------------------------------------------------------------
 * THE EDITORIAL LAW (owner-settled 2026-07-25, v2 spec §2):
 *
 *   "Truth about the record, attribution about the spin. When the record
 *    speaks, we say it plainly — numbers, dates, tallies, text — even when
 *    plainness lands harder on one side. Balance is not achieved by blunting
 *    facts. When the record is silent — motive, likelihood, what it really
 *    means — Oravan's voice stops, and named sources speak or nobody does.
 *    Speculation never wears our voice."
 *
 * How this script obeys it:
 *   - Every government-sourced update stores the verbatim action text beside
 *     the decoded one-liner (§2.4), so a wrong decode is falsifiable in a tap.
 *   - Every decoded line is run back through the gate's own three lint layers
 *     BEFORE it is stored. A line that hedges is not repaired and never gets a
 *     second attempt — it is discarded, and the government's own sentence is
 *     stored in its place.
 *   - The model is never shown the previous summary. A "where it stands"
 *     revision is regenerated FROM THE RECORD or not at all, so it cannot
 *     drift away from facts it can no longer check.
 *   - `changed_because` is computed here, from status diffs and update counts.
 *     Asking a model why it rewrote something would be asking it to narrate
 *     motive — exactly the silence the law requires.
 *
 * CONSTITUTIONAL POSTURE, written down because this is the nearest the
 * product comes to the line (v2 spec §6): the hard rule is "AI content is
 * always labeled, and never publishes unless the automated gates pass"
 * (CLAUDE.md, amended 2026-07-25 — this comment quoted the older, retired
 * "human-reviewed before it drives a call" wording until 2026-08-06, which
 * overstated what runs here). What actually holds on this path: an update
 * never drives a call — the phone CTA lives exclusively on the hand-authored
 * vehicle cards — every AI line is labeled `ai: true` in the data, chipped in
 * the UI, lint-gated in both languages before it can land (the one path where
 * the forbidden-vocabulary lint really does run), shipped beside the record it
 * decodes, and committed to git as a diff anyone can read after the fact. It
 * is not read by a person before it publishes, and nothing here says it is.
 * ---------------------------------------------------------------------------
 *
 * SPEND (v2 spec §6; per-token prices re-checked against the current model
 * catalogue on 2026-07-25). Update one-liners: ONE batched
 * claude-haiku-4-5-20251001 call per run, at most MOMENT_UPDATE_BATCH_CAP
 * events, skipped entirely — zero API calls — when the batch is empty, which
 * is the common case (the resolveWithHaiku discipline from
 * scripts/newsdesk.mjs). At $1/$5 per MTok a full 15-event batch is roughly 3K
 * in / 1.5K out ≈ $0.011; ~11 runs on a busy day ≈ $0.12/day. Summaries:
 * claude-sonnet-5, EN+ES in ONE call, at most MOMENT_SUMMARY_DAILY_CAP per
 * night and only when summaryNeedsRefresh says the issue actually moved —
 * ~$0.018/moment, so ≤ ~$0.15 on a night that hits the ceiling.
 * MOMENT_UPDATE_DAILY_EVENTS bounds how many events can be decoded in a UTC
 * day at all, which is what makes the black-swan ceiling code-enforced rather
 * than hoped-for. Congress.gov adds at most one free actions request per
 * moment vehicle per run, and only for vehicles that actually moved.
 *
 * NO PROMPT CACHING, deliberately: both prompts sit under the models' minimum
 * cacheable prefix (1024 tokens on Haiku 4.5, 512 on Sonnet 5), so a
 * cache_control breakpoint would silently cache nothing while still billing
 * the 1.25x write premium. Do not "optimize" this later without measuring the
 * rendered prompt first. NO BATCH API either: this step must finish before
 * verify-sync.mjs runs in the same job, and the Batches API is an unbounded
 * wait inside it.
 *
 * WRITE DISCIPLINE — the single most important behaviour in this file.
 * writeIfChanged() serializes, byte-compares, and NEVER restamps
 * _meta.generated_at on a no-op run. This script runs hourly; a restamped
 * timestamp alone would produce a commit, a deploy, and a rebuild every hour
 * forever, for no content whatsoever.
 *
 * BOUNDARIES: writes data/moment-updates.json and nothing else. Never touches
 * data/moments.json (hand-authored — that ownership split is what keeps
 * auto-commits and hand edits from contending over one file), data/bills.json,
 * data/coverage.json, or data/sync-state.json's nightly cursor.
 */
import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CONGRESS, cg } from './congress-fetch.mjs';
// The status-label clock, imported rather than copied a fourth time. The
// canonical definition is lib/journey.ts `statusKeyFor`; that file is
// TypeScript and this one is .mjs, and scripts/moment-candidates.mjs already
// carries the script-side twin that tests/journey.unit.spec.ts pins against
// the TS original corpus-wide. Importing the existing twin means a drift can
// only ever happen in ONE place, and that place is already under test.
// moment-candidates.mjs performs no I/O on import (its work sits behind a
// run-directly guard), so this costs nothing at module load.
import { statusKeyFor } from './moment-candidates.mjs';
import {
  extractBillsThisWeekSlugs,
  extractFloorFeedSlugs,
  extractMostViewedSlugs,
  mondayOfWeekET,
} from './newsdesk-match.mjs';
import {
  MAX_REVISIONS,
  RETENTION_DAYS,
  SCHEMA_VERSION,
  TEXT_MAX_CHARS,
  dedupeUpdates,
  etDay,
  lintRevisionText,
  lintUpdateText,
  pruneEntry,
  revisionId,
  shiftDay,
  summaryNeedsRefresh,
} from '../lib/moment-updates-gate.mjs';
import {
  actionToCandidate,
  billLabel,
  congressGovUrlForSlug,
  dailyEventCount,
  fallbackTextFor,
  floorScheduleItems,
  floorTodayItems,
  milestoneOf,
  momentVehicles,
  pressClusterToCandidate,
  scheduledToCandidate,
  slugParts,
  statusDiffToCandidate,
  suppressRedundantStatusChanges,
} from './moment-updates-map.mjs';

// ---- caps (v2 spec §6; every one of them code-enforced) ----
const MODE = process.env.MOMENT_UPDATES_MODE === 'nightly' ? 'nightly' : 'incremental';
const BATCH_CAP = Number(process.env.MOMENT_UPDATE_BATCH_CAP ?? 15);
const DAILY_EVENTS = Number(process.env.MOMENT_UPDATE_DAILY_EVENTS ?? 40);
const SUMMARY_DAILY_CAP = Number(process.env.MOMENT_SUMMARY_DAILY_CAP ?? 8);
const PRESS_WINDOW_DAYS = Number(process.env.MOMENT_PRESS_WINDOW_DAYS ?? 1);
const SUMMARY_WINDOW_DAYS = 14;

const DECODE_MODEL = 'claude-haiku-4-5-20251001';
const SUMMARY_MODEL = 'claude-sonnet-5';

const UPDATES_PATH = 'data/moment-updates.json';
// Congress.gov sits behind Cloudflare; this is the browser-shaped UA
// scripts/newsdesk.mjs already proved passes the RSS endpoints (2026-07-23).
const TIER0_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * The moment an in-flight candidate belongs to. Carried on the object under a
 * `__moment` key and STRIPPED before the update is stored — the update id
 * already hashes the moment id, so persisting it too would be a second copy
 * of the same fact that could drift from the first.
 */
const MOMENT_KEY = '__moment';

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * The UI's own plain-language status vocabulary (messages/*.json,
 * bills.status.*), read on FIRST USE and memoized for the rest of the run.
 * The summary prompt speaks in these phrases so the page and the prose can
 * never disagree about what a status is called — and so the raw enum never
 * reaches the model (first proof run leaked "floor_vote" into
 * published-candidate prose in both languages). Fallback: the token with
 * underscores spaced, still never shown as an enum.
 *
 * Lazy rather than eager for the same reason main() exists: importing this
 * module must perform no I/O, so tests/moment-updates-runner.unit.spec.ts can
 * drive the safety branches with no filesystem and no network.
 */
let statusPhrases = null;
const statusPhrase = (status, lang) => {
  statusPhrases ??= {
    en: readJSON('messages/en.json').bills?.status ?? {},
    es: readJSON('messages/es.json').bills?.status ?? {},
  };
  return statusPhrases[lang]?.[status] ?? String(status).replace(/_/g, ' ');
};

// The run's clock. Pure arithmetic, so it is safe at module scope: every step
// of one run reads the same instant, which is what makes a run's stamps and
// its retention floor agree with each other.
const now = new Date();
const nowISO = now.toISOString();
const todayET = etDay(now);
const todayUTC = nowISO.slice(0, 10);
const retentionFloor = shiftDay(todayET, -RETENTION_DAYS);

/**
 * The run's loaded state. DECLARED here because the collector steps below read
 * it as ambient context; ASSIGNED in loadRunState(), called only from main(),
 * because a bare `import` of this module must not open data/, shell out to
 * git, or construct an API client. Anything a test needs to drive is a
 * parameter of the function it drives — never one of these.
 */
let moments;
let billBySlug;
let originalText;
let store;
let vehicles;
let vehicleSlugs;
let knownIds;

function loadRunState() {
  moments = readJSON('data/moments.json');
  const bills = readJSON('data/bills.json');
  billBySlug = new Map(bills.map((b) => [b.full_identifier, b]));
  originalText = existsSync(UPDATES_PATH) ? readFileSync(UPDATES_PATH, 'utf8') : null;
  store = originalText ? JSON.parse(originalText) : { _meta: { schema: SCHEMA_VERSION, generated_at: nowISO } };

  vehicles = momentVehicles(moments);
  vehicleSlugs = [...new Set(vehicles.map((v) => v.slug))];
  console.log(`scope: ${vehicles.length} (moment, vehicle) pair(s), ${vehicleSlugs.length} distinct vehicle(s)`);

  // Every id already stored, so "what is new" is a diff and never a guess.
  knownIds = new Set();
  for (const [key, entry] of Object.entries(store)) {
    if (key === '_meta') continue;
    for (const u of entry?.updates ?? []) knownIds.add(u.id);
  }
}

/** Tag a candidate with its moment and collect it. */
function push(out, momentId, candidate) {
  if (!candidate) return;
  candidate[MOMENT_KEY] = momentId;
  out.push(candidate);
}

/* ------------------------------------------------------------------ *
 * 1 · status changes — zero network, HEAD vs the working corpus.
 * ------------------------------------------------------------------ */
function collectStatusChanges() {
  let head;
  try {
    head = JSON.parse(
      execSync('git show HEAD:data/bills.json', {
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
        // Silence git's "exists on disk, but not in HEAD" — a red fatal: in a
        // green log is exactly the noise that trains people to stop reading.
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    console.log('status changes: no HEAD:data/bills.json to diff against — skipping');
    return [];
  }
  // The pre-state MUST come from HEAD: congress-fetch.mjs's refreshBillFields
  // mutates the corpus IN PLACE, so an in-memory "before" would already be the
  // "after" by the time this step runs in the same job.
  const headBySlug = new Map(head.map((b) => [b.full_identifier, b]));
  const out = [];
  for (const { momentId, slug } of vehicles) {
    push(
      out,
      momentId,
      statusDiffToCandidate({
        momentId,
        vehicle: slug,
        before: headBySlug.get(slug),
        after: billBySlug.get(slug),
        billUrl: congressGovUrlForSlug(slug),
        recordedAt: nowISO,
      }),
    );
  }
  console.log(`status changes: ${out.length} candidate(s)`);
  return out;
}

/* ------------------------------------------------------------------ *
 * 2 · vehicle actions — one /actions request per vehicle that moved.
 * ------------------------------------------------------------------ */

/** Newest stored congress_actions day for a vehicle, across every moment. */
function newestStoredDay(slug) {
  let newest = null;
  for (const [key, entry] of Object.entries(store)) {
    if (key === '_meta') continue;
    for (const u of entry?.updates ?? []) {
      if (u?.vehicle !== slug || u.source?.kind !== 'congress_actions') continue;
      if (!newest || String(u.day) > newest) newest = String(u.day);
    }
  }
  return newest;
}

async function collectVehicleActions() {
  const out = [];
  for (const slug of vehicleSlugs) {
    const stored = newestStoredDay(slug);
    const lastAction = billBySlug.get(slug)?.last_action_date ?? null;
    // Fetch when the corpus has moved past what we already store, or when we
    // have never stored an action for this vehicle. A vehicle that has not
    // moved costs zero requests.
    if (stored && lastAction && lastAction <= stored) {
      console.log(`  actions ${slug}: skipped (stored through ${stored}, corpus at ${lastAction})`);
      continue;
    }

    const { type, number } = slugParts(slug);
    let actions;
    try {
      const page = await cg(`/bill/${CONGRESS}/${type}/${number}/actions`, { limit: 250 });
      actions = page.actions ?? [];
    } catch (e) {
      console.error(`  actions ${slug} FAILED: ${e.message}`);
      continue;
    }

    const momentIds = vehicles.filter((v) => v.slug === slug).map((v) => v.momentId);
    let kept = 0;
    for (const action of actions) {
      const day = String(action?.actionDate ?? '').slice(0, 10);
      if (!day) continue;
      // Never collect an event the very next prune would delete, and never a
      // date the record does not support.
      if (day < retentionFloor || day > todayET) continue;
      for (const momentId of momentIds) {
        const c = actionToCandidate({
          momentId,
          vehicle: slug,
          action,
          billUrl: congressGovUrlForSlug(slug),
          recordedAt: nowISO,
        });
        if (!c) continue;
        push(out, momentId, c);
        kept++;
      }
    }
    const milestones = actions.filter((a) => milestoneOf(a)).length;
    console.log(
      `  actions ${slug}: ${actions.length} action(s), ${milestones} milestone match(es), ${kept} candidate(s) inside retention`,
    );
  }
  console.log(`vehicle actions: ${out.length} candidate(s)`);
  return out;
}

/* ------------------------------------------------------------------ *
 * 3 · tier-0 government feeds -> `scheduled`.
 * ------------------------------------------------------------------ */
const TIER0_SOURCES = [
  { label: 'house-floor-today', url: () => 'https://www.congress.gov/rss/house-floor-today.xml', kind: 'floor_today' },
  { label: 'senate-floor-today', url: () => 'https://www.congress.gov/rss/senate-floor-today.xml', kind: 'floor_today' },
  {
    // Fetched, logged, and DELIBERATELY NOT turned into updates. "Most viewed
    // on congress.gov this week" is a popularity signal, not a schedule, and
    // no honest update class fits it: filing it as `scheduled` would claim a
    // floor date the record does not support (v2 spec §9.5). It is still
    // fetched because its overlap with a moment's vehicles is worth seeing in
    // the run log — and because that overlap is the signal a curator uses when
    // deciding whether a moment should open at all.
    label: 'most-viewed-bills',
    url: () => 'https://www.congress.gov/rss/most-viewed-bills.xml',
    kind: 'observability',
  },
  {
    label: 'house-bills-this-week',
    url: () => {
      const monday = mondayOfWeekET(now);
      return `https://docs.house.gov/billsthisweek/${monday}/${monday}.xml`;
    },
    kind: 'floor_schedule',
    okOn404: true, // no session scheduled this week — a clean no-op, not an error
  },
];

async function fetchTier0(src) {
  const res = await fetch(src.url(), {
    signal: AbortSignal.timeout(20_000),
    headers: { 'User-Agent': TIER0_USER_AGENT },
  });
  if (res.status === 404 && src.okOn404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function collectTier0() {
  const out = [];
  const results = await Promise.allSettled(TIER0_SOURCES.map(fetchTier0));
  const wanted = new Set(vehicleSlugs);

  results.forEach((r, i) => {
    const src = TIER0_SOURCES[i];
    if (r.status !== 'fulfilled') {
      console.error(`  tier-0 ${src.label} FAILED: ${r.reason?.message ?? r.reason}`);
      return;
    }
    const xml = r.value;
    if (xml === null) {
      console.log(`  tier-0 ${src.label}: 404 — no session week, clean no-op`);
      return;
    }

    if (src.kind === 'observability') {
      const hits = extractMostViewedSlugs(xml).filter((s) => wanted.has(s));
      console.log(
        `  tier-0 ${src.label}: ${hits.length} moment vehicle(s) in the weekly top-10 (observability only, never an update)`,
      );
      return;
    }

    if (src.kind === 'floor_today') {
      // floorTodayItems' slug set is pinned equal to extractFloorFeedSlugs by
      // the unit suite; the intersection below makes that agreement load-bearing
      // at runtime too, so a future divergence cannot silently widen selection.
      const feedSlugs = new Set(extractFloorFeedSlugs(xml));
      const items = floorTodayItems(xml).filter((it) => feedSlugs.has(it.slug));
      for (const item of items) {
        if (!wanted.has(item.slug)) continue;
        const refs = [src.url()];
        if (item.link && /^https:\/\//.test(item.link)) refs.push(item.link);
        for (const { momentId, slug } of vehicles) {
          if (slug !== item.slug) continue;
          push(
            out,
            momentId,
            scheduledToCandidate({
              momentId,
              vehicle: slug,
              // The feed's own semantics are "today": it names the bills on
              // that chamber's floor today and carries no per-item date.
              day: todayET,
              actionText: item.description ? `${item.label} — ${item.description}` : item.label,
              actionType: item.feedTitle,
              sourceSystem: `Congress.gov ${src.label} RSS`,
              refs,
              recordedAt: nowISO,
            }),
          );
        }
      }
      console.log(
        `  tier-0 ${src.label}: ${items.length} bill(s) listed, ${items.filter((it) => wanted.has(it.slug)).length} on a moment vehicle`,
      );
      return;
    }

    // floor_schedule — the weekly look-ahead.
    const weekSlugs = new Set(extractBillsThisWeekSlugs(xml));
    const items = floorScheduleItems(xml).filter((it) => weekSlugs.has(it.slug));
    let matched = 0;
    for (const item of items) {
      if (!wanted.has(item.slug)) continue;
      // add-date is the day the House PUT this bill on the week's schedule — a
      // real, dated government act, and the only honest day for a look-ahead
      // listing. Date part only: the stamp carries no timezone offset and is
      // ET-local (see floorScheduleItems).
      const day = item.addDate;
      if (!day || day < retentionFloor || day > todayET) continue;
      matched++;
      for (const { momentId, slug } of vehicles) {
        if (slug !== item.slug) continue;
        push(
          out,
          momentId,
          scheduledToCandidate({
            momentId,
            vehicle: slug,
            day,
            actionText: item.floorText ? `${item.legisNum} — ${item.floorText}` : item.legisNum,
            actionType: item.category,
            sourceSystem: `docs.house.gov floor schedule, week of ${item.weekDate ?? 'unknown'}`,
            refs: [src.url()],
            recordedAt: nowISO,
          }),
        );
      }
    }
    console.log(
      `  tier-0 ${src.label}: ${items.length} scheduled item(s), ${matched} on a moment vehicle inside retention`,
    );
  });

  console.log(`tier-0: ${out.length} scheduled candidate(s)`);
  return out;
}

/* ------------------------------------------------------------------ *
 * 4 · press clusters (nightly only).
 * ------------------------------------------------------------------ */
function collectPressClusters() {
  if (!existsSync('data/coverage.json') || !existsSync('data/media-bias.json')) {
    console.log('press clusters: coverage or media-bias file missing — skipping');
    return [];
  }
  const coverage = readJSON('data/coverage.json');
  const leanByDomain = readJSON('data/media-bias.json').outlets ?? {};
  const floor = shiftDay(todayET, -PRESS_WINDOW_DAYS);
  const out = [];

  for (const slug of vehicleSlugs) {
    const articles = Array.isArray(coverage[slug]) ? coverage[slug] : [];
    /** @type {Map<string, any[]>} day -> that day's articles */
    const byDay = new Map();
    for (const a of articles) {
      // publishedAt is a bare calendar day in this corpus, and etDay returns a
      // bare day verbatim — so this is the article's own day either way.
      const day = etDay(a?.publishedAt);
      if (!day || day < floor || day > todayET) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(a);
    }
    for (const [day, group] of byDay) {
      for (const { momentId, slug: s } of vehicles) {
        if (s !== slug) continue;
        push(
          out,
          momentId,
          pressClusterToCandidate({
            momentId,
            vehicle: slug,
            day,
            articles: group,
            leanByDomain,
            recordedAt: nowISO,
          }),
        );
      }
    }
  }
  console.log(`press clusters: ${out.length} candidate(s) in the last ${PRESS_WINDOW_DAYS} day(s)`);
  return out;
}

/* ------------------------------------------------------------------ *
 * 5 · decode — ONE batched Haiku call, or none at all.
 * ------------------------------------------------------------------ */

const LAW_BRIEF = `Oravan's editorial law, which your output must obey:
"Truth about the record, attribution about the spin. When the record speaks, we say it plainly — numbers, dates, tallies, text — even when plainness lands harder on one side. Balance is not achieved by blunting facts. When the record is silent — motive, likelihood, what it really means — Oravan's voice stops, and named sources speak or nobody does. Speculation never wears our voice."`;

const FRAMING_RULES = `RULES (a line that breaks any of these is discarded and replaced by the raw record):
- State ONLY what the supplied record says. Never add motive, consequence, likelihood, or what it "means".
- NO hedging or forecasting of any kind: no "expected to", "likely to", "could", "might", "set to", "poised to", "on track to"; no "se espera", "probablemente", "podria", "podrian", "estaria", "previsto que", "a punto de". A record claim is stated flatly or not stated.
- Never name a political party, and never use advocacy verbs (fight, resist, stop, save, defend, block) or crisis/attack/scheme framing, in either language.
- Reproduce every tally, roll-call number, vote count and date exactly as the record gives it.
- Each line is ONE sentence, at most 160 characters, plain text, no markdown, sentence case.
- Spanish is natural Latin American Spanish at an 8th-grade reading level, carrying the same facts and the same numbers. Bill numbers stay in their English citation form (H.R. 9770, S.J.Res. 185).
- For a "press_cluster" item there is no government record: say only that the named outlets published coverage of that bill, and NAME at least one of the listed outlets in BOTH languages.`;

function decodePayload(candidate) {
  const base = { class: candidate.class, bill: billLabel(candidate.vehicle), day: candidate.day };
  if (candidate.class === 'press_cluster') return { ...base, outlets: candidate.source.outlet_names };
  return {
    ...base,
    record_text: candidate.record.action_text,
    action_code: candidate.record.action_code,
    source_system: candidate.record.source_system,
    roll_call: candidate.record.roll_call ?? null,
  };
}

/**
 * Exported for tests/moment-updates-runner.unit.spec.ts: every exit from this
 * function is a degrade-to-safe path (an outage, unparseable output, a
 * hallucinated index), and a silent regression in any of them would put
 * invented content into the store instead of the government's own sentence.
 * `anthropic` is a parameter precisely so a test can inject a throwing client.
 */
export async function decodeUpdates(anthropic, batch) {
  if (batch.length === 0 || !anthropic) return new Map();

  const items = batch.map((c, i) => `${i}. ${JSON.stringify(decodePayload(c))}`).join('\n');
  let text;
  try {
    const msg = await anthropic.messages.create({
      model: DECODE_MODEL,
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: `You write one-sentence, bilingual descriptions of things the United States Congress has already done, for a nonpartisan civic site.

${LAW_BRIEF}

${FRAMING_RULES}

ITEMS (each is one event; "record_text" is the government's own verbatim text):
${items}

Output STRICT JSON only — an array like [{"i":0,"en":"…","es":"…"}] — no prose, no markdown fences, no other text.`,
        },
      ],
    });
    text = msg.content[0]?.type === 'text' ? msg.content[0].text : '';
  } catch (e) {
    console.error(`decode call failed: ${e.message} — every item falls back to the verbatim record`);
    return new Map();
  }

  try {
    const jsonText = text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(jsonText);
    const out = new Map();
    for (const row of Array.isArray(parsed) ? parsed : []) {
      // Never trust an index the batch did not offer — the newsdesk rule that
      // keeps a hallucinated row out of the pipeline.
      if (!row || typeof row.i !== 'number' || !batch[row.i]) continue;
      if (typeof row.en !== 'string' || typeof row.es !== 'string') continue;
      out.set(row.i, { en: row.en.trim(), es: row.es.trim() });
    }
    return out;
  } catch (e) {
    console.error(`decode JSON parse failed: ${e.message} — every item falls back to the verbatim record`);
    return new Map();
  }
}

/** Lint one bilingual pair against the gate. Returns failure strings. */
export function lintPair(text, klass, outletNames) {
  const failures = [];
  for (const lang of ['en', 'es']) {
    const value = text?.[lang] ?? '';
    if (!value.trim()) {
      failures.push(`${lang}: empty`);
      continue;
    }
    if (value.length > TEXT_MAX_CHARS) failures.push(`${lang}: ${value.length} chars over the ${TEXT_MAX_CHARS} ceiling`);
    for (const f of lintUpdateText(value, lang, klass, outletNames)) failures.push(`${lang}: ${f}`);
  }
  return failures;
}

/* ------------------------------------------------------------------ *
 * 6 · state summaries (nightly only).
 * ------------------------------------------------------------------ */

/**
 * Why this revision exists — computed HERE from the record, never narrated by
 * the model (see the header).
 */
function changedBecause(entry, statuses, previous) {
  const reasons = [];
  if (!previous) return ['first-summary'];
  const grounded = previous.grounded_in?.vehicle_statuses ?? {};
  for (const [slug, status] of Object.entries(statuses)) {
    if (grounded[slug] !== status) reasons.push(`status:${slug} ${grounded[slug] ?? 'unknown'}→${status}`);
  }
  const since = Date.parse(previous.generated_at);
  const fresh = (entry.updates ?? []).filter((u) => Date.parse(u.recorded_at) > since).length;
  if (fresh > 0) reasons.push(`updates:+${fresh}`);
  if (reasons.length === 0) {
    reasons.push(`reanchor:${Math.max(0, Math.round((now.getTime() - since) / 86_400_000))}d`);
  }
  return reasons;
}

// The model must NEVER see a raw status enum — the first live proof run
// (2026-07-25) leaked "sits at floor_vote status" / "estado floor_vote"
// straight into reader-facing prose in both languages. Feed it the same
// plain-language phrases the UI uses (messages/*.json bills.status.*), per
// language, and the enum never enters the model's vocabulary at all.
// ...but the UI's own phrase for `floor_vote` was "Heading to a vote", which
// is a FORECAST. Instructing the model to reuse UI phrases verbatim then
// published "S.J.Res. 185 and S.J.Res. 172 are heading to a vote" above a
// timeline recording both motions rejected (pre-launch audit, 2026-07-25).
// The summary speaks only about the record, so forward-looking labels are
// rewritten to record-only phrasing HERE, at the boundary, rather than
// hoping the model declines a word we handed it. The lint now also rejects
// these idioms outright, so this is the belt and that is the braces.
//
// KEYED BY THE CLOCKED STATUS KEY, NOT THE RAW ENUM (N12, 2026-08-12). This
// table used to be read with `bill.status` straight out of data/bills.json,
// so every `floor_vote` vehicle was handed "on the floor calendar" in the
// present tense no matter what the record said — and this was the last
// unclocked producer of that phrase after #211 fixed every rendered surface.
// Two different false sentences reached PUBLISHED summary prose because of it,
// both still in data/moment-updates.json on the day this was written:
//
//   "S. 4784 stands on the floor calendar." (2026-08-11) — s-4784-119's last
//   action is a motion to proceed made in the Senate. It has never been placed
//   on a calendar at all.
//   "S. 3172 sits on the Senate floor calendar." (2026-08-09) — a real
//   placement, dated 2026-07-27, i.e. present tense over a placement that
//   had gone quiet.
//
// So the phrase is chosen by `statusKeyFor` (scripts/moment-candidates.mjs,
// the script-side twin of lib/journey.ts's, pinned against it corpus-wide by
// tests/journey.unit.spec.ts) exactly as a page or an embed card chooses a
// label, and it answers all three keys:
//
//   floor_vote        a placement inside the signal window → present tense,
//                     unchanged.
//   floor_vote_stale  the same placement, aged out → past tense, plus the
//                     since-clause that is what makes the demotion honest.
//                     Wording carried from #211's shipped copy (messages/*.json
//                     `journey.nowFloorStale`) minus its chamber select, since
//                     a moment can carry vehicles in both chambers and this
//                     line is per measure, not per chamber.
//   floor_activity    no placement sentence at all → falls through to the UI's
//                     own "Floor activity" / "Actividad en el pleno", which
//                     claims nothing about a calendar. NOT clocked, per #211.
//
// FAIL CLOSED: a vehicle whose record is not in scope (no last action text or
// date reaches this function) resolves to `floor_activity` by the same route —
// the weaker claim, never the calendar one.
const RECORD_ONLY_PHRASE = {
  floor_vote: { en: 'on the floor calendar', es: 'en el calendario del pleno' },
  floor_vote_stale: {
    en: 'was placed on the floor calendar, and the official record shows no floor action on it since',
    es: 'se incluyó en el calendario del pleno, y el registro oficial no muestra ninguna acción en el pleno desde entonces',
  },
};

/**
 * The plain-language phrase one measure is described by, in one language.
 *
 * Exported for the unit suite: this is the boundary the whole "no forecast in
 * our voice" doctrine runs through, and the clock on it is the fix N12 exists
 * for. `now` is injectable for the same reason statusKeyFor's is — a test
 * must be able to age a placement without waiting a fortnight.
 *
 * @param {string} status  the raw bill status
 * @param {{ lastActionText?: string|null, lastActionDate?: string|null }|null|undefined} record
 * @param {'en'|'es'} lang
 * @param {number} [nowMs]
 * @returns {string}
 */
export function recordStatusPhrase(status, record, lang, nowMs = now.getTime()) {
  const key = statusKeyFor(status, record?.lastActionText ?? null, record?.lastActionDate ?? null, nowMs);
  return RECORD_ONLY_PHRASE[key]?.[lang] ?? statusPhrase(key, lang);
}

/**
 * Exported for the unit suite: the lint-rejection branch below is the whole of
 * the "there is no fallback for a summary" doctrine, and until now it was a
 * comment with nothing behind it.
 *
 * @param {Record<string, string>} statuses slug -> raw status. UNCHANGED shape
 *   on purpose: it is persisted as `grounded_in.vehicle_statuses` and diffed
 *   by summaryNeedsRefresh, so the clock rides a SEPARATE map rather than
 *   rewriting what a revision says it was grounded in.
 * @param {Record<string, {lastActionText: string|null, lastActionDate: string|null}>} [records]
 */
export async function generateStateSummary(anthropic, momentId, entry, statuses, contextRefs, records = {}) {
  const windowFloor = shiftDay(todayET, -SUMMARY_WINDOW_DAYS);
  const recent = (entry.updates ?? []).filter((u) => u.day >= windowFloor).slice(0, 30);

  const recordLines = recent
    .map((u) =>
      u.class === 'press_cluster'
        ? `- ${u.day} [${u.class}] ${billLabel(u.vehicle)}: coverage published by ${(u.source.outlet_names ?? []).join(', ')}`
        : `- ${u.day} [${u.class}] ${billLabel(u.vehicle)}: ${u.record?.action_text ?? ''}`,
    )
    .join('\n');
  // See RECORD_ONLY_PHRASE above: the phrase per measure is chosen by the same
  // clocked status key every rendered surface routes through.
  const statusLines = Object.entries(statuses)
    .map(
      ([slug, status]) =>
        `- ${billLabel(slug)}: EN "${recordStatusPhrase(status, records[slug], 'en')}" / ES "${recordStatusPhrase(status, records[slug], 'es')}"`,
    )
    .join('\n');

  // Institutional grounding: the moment's hand-curated context_refs plus the
  // Congress.gov page for each vehicle. cboCostEstimates ride the bill-DETAIL
  // payload, which data/bills.json does not persist — wire them in here the
  // day the corpus starts carrying them rather than spending a second detail
  // request per vehicle per night for a link.
  const refs = [
    ...new Set([...Object.keys(statuses).map(congressGovUrlForSlug), ...contextRefs.filter((r) => /^https:\/\//.test(r))]),
  ];

  let text;
  try {
    const msg = await anthropic.messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 1400,
      // Sonnet 5 runs adaptive thinking when the field is OMITTED; this is a
      // short, fully-grounded rewrite, so unbounded thinking spend would blow
      // the nightly budget for no quality gain. Disabled is accepted on
      // Sonnet 5 (unlike an effort of xhigh/max on the Opus line).
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'user',
          content: `Write a nonpartisan "Where it stands" summary of one congressional fight, in English and Spanish, for an everyday US resident reading at an 8th-grade level.

${LAW_BRIEF}

RULES:
- Use ONLY the statuses and records below. Never add motive, likelihood, consequence, or what any of it "means".
- NO hedging or forecasting: no "expected to", "likely to", "could", "might", "set to", "poised to", "on track to"; no "se espera", "probablemente", "podria", "podrian", "estaria", "previsto que", "a punto de".
- Never name a political party; never use advocacy verbs (fight, resist, stop, save, defend, block) or crisis/attack/scheme framing, in either language.
- Reproduce every tally and roll-call number exactly as given.
- 90 to 140 words per language. Plain text, no markdown, no headings.

VOICE — "where it stands", not a log:
- Open with the single most important CURRENT fact (where the live question sits right now), then how it got there. Group measures that are in the same place instead of reciting them one by one.
- Status words: use ONLY the quoted plain-language phrases given per measure below. NEVER an internal token like "floor_vote" or "passed_chamber" — if you find yourself writing an underscore, stop.
- Dates as a reader says them: "July 23, 2026" in English, "23 de julio de 2026" in Spanish. Never ISO "2026-07-23" in prose.
- Vote language localized: EN "by a recorded vote of 214 to 208 (Roll no. 282)"; ES "por votacion nominal de 214 a 208 (votacion num. 282)". Never leave "Yeas and Nays" untranslated in Spanish.
- The Spanish is native-quality Spanish with correct accents and diacritics (aprobó, Cámara, comité, votación, últimos) — not a transliteration.
- No meta-commentary about this summary itself (never "this summary reflects…", "as of this record…"). The page already stamps the date.
- If nothing has moved recently, say that plainly.

CURRENT STATUS OF EACH MEASURE:
${statusLines}

THE RECORD, LAST ${SUMMARY_WINDOW_DAYS} DAYS (newest first):
${recordLines || '- nothing recorded in this window'}

Output STRICT JSON only — {"en":"…","es":"…"} — no prose, no markdown fences, no other text.`,
        },
      ],
    });
    text = msg.content[0]?.type === 'text' ? msg.content[0].text : '';
  } catch (e) {
    console.error(`  summary ${momentId} call failed: ${e.message}`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''));
  } catch (e) {
    console.error(`  summary ${momentId} JSON parse failed: ${e.message}`);
    return null;
  }
  if (typeof parsed?.en !== 'string' || typeof parsed?.es !== 'string') {
    console.error(`  summary ${momentId}: the model returned no EN/ES pair`);
    return null;
  }

  const failures = [];
  for (const lang of ['en', 'es']) {
    const value = parsed[lang].trim();
    if (!value) failures.push(`${lang}: empty`);
    for (const f of lintRevisionText(value, lang)) failures.push(`${lang}: ${f}`);
  }
  if (failures.length) {
    // There is no fallback for a summary: a "where it stands" paragraph is
    // Oravan's own voice, and no government sentence can stand in for it. The
    // previous revision simply stands — honest, because it is still grounded
    // in a record nothing here has contradicted.
    console.warn(`  summary ${momentId} REJECTED, the previous revision stands: ${failures.join('; ')}`);
    return null;
  }

  const generatedAt = new Date().toISOString();
  return {
    id: revisionId([momentId, todayET, generatedAt]),
    generated_at: generatedAt,
    as_of_day: todayET,
    text: { en: parsed.en.trim(), es: parsed.es.trim() },
    grounded_in: { vehicle_statuses: statuses, update_ids: recent.map((u) => u.id), refs },
    changed_because: changedBecause(entry, statuses, (entry.summary_revisions ?? []).at(-1) ?? null),
    model: SUMMARY_MODEL,
  };
}

/* ------------------------------------------------------------------ *
 * 7 · write.
 * ------------------------------------------------------------------ */

/**
 * Serialize, byte-compare, and NEVER restamp _meta.generated_at on a no-op.
 *
 * This is the line that decides whether an hourly cron is a news pipeline or a
 * deploy storm. The comparison serializes with the file's EXISTING
 * generated_at in place, so a run that found nothing produces a byte-identical
 * string and writes nothing at all.
 *
 * `sink` is the only reason this takes a third argument: it runs 24x a day and
 * went untested for exactly one reason — the only way to observe it was to let
 * it overwrite the repo's real data file. The default IS the real write, so
 * production behaviour is unchanged; a test passes a recorder instead and can
 * then assert the thing that matters, which is that a no-op writes NOTHING.
 *
 * @param {Record<string, any>} next the entries, without _meta
 * @param {string|null} previousText the file's current bytes, or null if absent
 * @param {{ path?: string, sink?: (path: string, text: string) => void }} [opts]
 * @returns {boolean} whether anything was written
 */
/**
 * Apply the storage envelopes to every moment in the store, IN EVERY MODE.
 *
 * Exported for one reason: this used to be an inline loop inside main()'s
 * `if (MODE === 'nightly')` block, and "which modes enforce the envelopes" is
 * exactly the kind of fact that cannot be asserted about an inline loop in an
 * unexported async function. It is a wiring bug that only a wiring test can
 * catch, so the wiring became a function. See the call site in main() for the
 * full account of what nightly-only cost.
 *
 * MUTATES `store` — deleting the entry of a retired or removed moment and
 * replacing every other with its pruned self — because that is what the loop
 * it replaced did, and because the caller's next step is to serialize `store`.
 * pruneEntry itself stays pure; this is the one place the mutation lives.
 *
 * `mode` selects ONLY `reserveRevisions`, and it must be 0 on the incremental
 * path: reserving holds a slot open for a revision the run is about to append
 * (the arithmetic fix for the night a moment at MAX_REVISIONS committed 31,
 * one past what check-moment-updates accepts, reddening main after the nightly
 * had already deployed — 2026-08-06). An incremental run appends no revision,
 * so reserving there would evict the oldest surviving revision every hour to
 * make room for nothing.
 *
 * @param {Record<string, any>} store   the parsed store, keyed by moment id
 * @param {Record<string, any>} moments parsed data/moments.json
 * @param {{ now: number|Date|string, mode: 'nightly'|'incremental' }} opts
 * @returns {string[]} the moment ids whose entry was deleted, for the log
 */
export function pruneStore(store, moments, { now, mode }) {
  const deleted = [];
  for (const momentId of Object.keys(store)) {
    if (momentId === '_meta') continue;
    const moment = moments?.[momentId];
    const pruned = pruneEntry(store[momentId], {
      now,
      retired: !moment || moment.status === 'retired',
      reserveRevisions: mode === 'nightly' ? 1 : 0,
    });
    if (pruned === null) {
      /* A retired (or deleted) moment's updates leave the file entirely: git
         history IS the archive, and a second archive nothing renders is dead
         weight (v2 spec §4). Doing this hourly rather than nightly also
         SHORTENS the window in which check-moment-updates fails on a
         stored-retired moment that still carries an entry — that is a
         violation there, not a warning. */
      delete store[momentId];
      deleted.push(momentId);
    } else {
      store[momentId] = pruned;
    }
  }
  return deleted;
}

/* The default sink is the real write, wrapped rather than passed bare. `fs`'s
   own signature accepts a numeric file descriptor and an options argument this
   contract does not have, so `sink = writeFileSync` made the inferred type of
   the parameter wider than the documented one — and every test passing the
   (path: string, text: string) recorder the JSDoc above describes failed
   `tsc --noEmit` the moment anything else in the same spec imported node:fs.
   The wrapper is the JSDoc contract, executable. Production behaviour is
   byte-identical: this is still writeFileSync(path, text). */
const defaultSink = (/** @type {string} */ p, /** @type {string} */ text) => writeFileSync(p, text);

export function writeIfChanged(next, previousText, { path = UPDATES_PATH, sink = defaultSink } = {}) {
  const priorStamp = previousText ? JSON.parse(previousText)?._meta?.generated_at : null;
  const shaped = (stamp) => `${JSON.stringify({ _meta: { schema: SCHEMA_VERSION, generated_at: stamp }, ...next }, null, 2)}\n`;
  if (previousText !== null && shaped(priorStamp ?? nowISO) === previousText) {
    console.log(`DONE: no change — ${path} left untouched (no restamp, no commit, no deploy)`);
    return false;
  }
  const finalText = shaped(nowISO);
  sink(path, finalText);
  console.log(`DONE: wrote ${path} (${Buffer.byteLength(finalText)} bytes)`);
  return true;
}

/**
 * Attach the final bilingual pair to every admitted candidate, and label it.
 *
 * This is where the editorial law lands on machine text: a decoded line is
 * accepted ONLY if it clears the gate's own lint, and a line that hedges is
 * not repaired and gets no second attempt — the government's own sentence
 * takes its place, labelled `ai: false`. Overflow past the batch cap never saw
 * the model at all and takes the same fallback.
 *
 * Mutates the candidates (they are this run's in-flight objects) and returns
 * the counts the run log prints. Exported because the rejection branch is the
 * one that keeps a forecast out of Oravan's voice, and forecasts have reached
 * production prose here twice.
 */
export function assignUpdateText(batch, overflow, decodedByIndex) {
  let aiCount = 0;
  let fallbackCount = 0;
  for (const [i, c] of batch.entries()) {
    const proposed = decodedByIndex.get(i);
    const failures = proposed ? lintPair(proposed, c.class, c.source?.outlet_names ?? []) : ['no line returned'];
    if (failures.length === 0) {
      c.text = proposed;
      c.ai = true;
      aiCount++;
    } else {
      if (proposed) console.warn(`  decode REJECTED ${c.id} (${c.class} ${c.vehicle} ${c.day}): ${failures.join('; ')}`);
      c.text = fallbackTextFor(c);
      c.ai = false;
      fallbackCount++;
    }
  }
  for (const c of overflow) {
    c.text = fallbackTextFor(c);
    c.ai = false;
    fallbackCount++;
  }
  return { aiCount, fallbackCount };
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

async function main() {
  console.log(`moment-updates: mode=${MODE}, ET day ${todayET}`);
  loadRunState();

  const candidates = [];
  candidates.push(...collectStatusChanges());
  candidates.push(...(await collectVehicleActions()));
  candidates.push(...(await collectTier0()));
  if (MODE === 'nightly') candidates.push(...collectPressClusters());

  // One event seen from two angles (the bills.json diff and the actions
  // endpoint) must render once, not twice — the action is the richer record.
  const afterSuppression = suppressRedundantStatusChanges(candidates);

  const seen = new Set();
  const fresh = [];
  for (const c of afterSuppression) {
    if (knownIds.has(c.id) || seen.has(c.id)) continue;
    seen.add(c.id);
    fresh.push(c);
  }
  console.log(`${candidates.length} candidate(s) collected, ${fresh.length} not already stored`);

  // Daily event ceiling, counted off the STORED file's recorded_at (§6) — no new
  // Actions cache has to exist for it to hold across runs.
  const recordedToday = dailyEventCount(store, todayUTC);
  const dailyRoom = Math.max(0, DAILY_EVENTS - recordedToday);
  if (fresh.length > dailyRoom) {
    console.warn(
      `daily ceiling: ${recordedToday} event(s) already recorded on ${todayUTC}; admitting ${dailyRoom} of ${fresh.length} — the rest re-collect on the next run`,
    );
  }
  const admitted = fresh.slice(0, dailyRoom);

  const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ maxRetries: 8 }) : null;
  if (!anthropic) console.warn('ANTHROPIC_API_KEY unset — every update carries the verbatim record with ai:false');

  const batch = admitted.slice(0, BATCH_CAP);
  const overflow = admitted.slice(BATCH_CAP);
  if (overflow.length) {
    console.warn(
      `batch cap: ${overflow.length} event(s) past MOMENT_UPDATE_BATCH_CAP=${BATCH_CAP} are STORED with the verbatim record — never dropped, because the store keeps every qualified event (§3)`,
    );
  }
  const decodedByIndex = await decodeUpdates(anthropic, batch);
  console.log(
    `decode: ${batch.length} event(s) batched${batch.length ? '' : ' (skipped — empty batch, zero API calls)'}, ${decodedByIndex.size} line(s) returned`,
  );

  const { aiCount, fallbackCount } = assignUpdateText(batch, overflow, decodedByIndex);
  console.log(`text: ${aiCount} AI-decoded, ${fallbackCount} verbatim-record fallback`);

  // A fallback can itself fail the lint: the speculation layer is NOT
  // quote-exempt, so a record sentence carrying a forecast construction has
  // nowhere left to go. Drop it loudly rather than redden CI on a nightly
  // commit — the event is still one tap away on Congress.gov, and the day's
  // honest overflow line links there.
  const storable = admitted.filter((c) => {
    const failures = lintPair(c.text, c.class, c.source?.outlet_names ?? []);
    if (failures.length === 0) return true;
    console.error(
      `  DROPPED ${c.id} (${c.class} ${c.vehicle} ${c.day}) — even the verbatim record fails the lint: ${failures.join('; ')}`,
    );
    return false;
  });

  // ---- merge ----
  const touched = new Set();
  for (const c of storable) {
    const momentId = c[MOMENT_KEY];
    delete c[MOMENT_KEY];
    if (!store[momentId]) store[momentId] = { updates: [], summary_revisions: [] };
    store[momentId].updates = dedupeUpdates(store[momentId].updates ?? [], [c]);
    touched.add(momentId);
  }
  console.log(`merge: ${storable.length} update(s) into ${touched.size} moment(s)`);

  /* ---- prune: EVERY MODE, and that is the fix ----------------------------
   *
   * THE ENVELOPES HELD ON 1 WRITE IN 25. This loop lived inside the
   * `if (MODE === 'nightly')` block below, one statement further down, so
   * pruneEntry — which enforces HARD_DAY_CEILING (12 updates per moment-day),
   * MAX_UPDATES_PER_MOMENT (200), the retention window, the correction/
   * revision referential-integrity rewrite, and the retired-moment deletion —
   * ran on the nightly run only. The hourly newsdesk workflow runs this same
   * script with MOMENT_UPDATES_MODE=incremental (cron '7 * * * *') and
   * `git add data/` COMMITS AND DEPLOYS data/moment-updates.json exactly as
   * the nightly does. So on 24 of the day's 25 writes the storage envelopes
   * were not enforced at all, on the path that publishes.
   *
   * WHAT THAT ACTUALLY BREAKS, which is worse than an oversized file. A
   * multi-vehicle moment on a busy day — iran-war-powers carries four
   * vehicles — can cross 12 updates in one moment-day through increments
   * alone, and `> HARD_DAY_CEILING` is a VIOLATION in
   * scripts/check-moment-updates.mjs, not a warning. That gate is a required
   * step on every PR and every push to main. The incremental run would commit
   * and deploy the file, and the NEXT nightly (and every unrelated PR in
   * between) would go red against data already in production — a scheduled,
   * self-inflicted CI outage with no code change to blame it on. That is the
   * same failure lib/moment-updates-gate.mjs's own REFERENTIAL INTEGRITY note
   * describes, reached by a different door.
   *
   * WHY IT WAS NIGHTLY-ONLY: nothing found in code, comment, or spec says it
   * had to be. It reads as incidental — the prune was written where the
   * summary loop needed it (immediately before, see the ordering note below)
   * and inherited that block's mode guard rather than choosing it. Nothing in
   * pruneEntry is nightly-specific: it is pure, it takes `now`, it makes no
   * API call and costs nothing, and an incremental run that trims nothing
   * produces a byte-identical file that writeIfChanged declines to write. The
   * one genuinely mode-specific input is `reserveRevisions`, handled below.
   *
   * THE ORDERING IS STILL LOAD-BEARING — this runs BEFORE the summary loop and
   * must stay there. generateStateSummary builds its prompt from
   * `entry.updates` and grounds the revision in `recent.map(u => u.id)`;
   * pruning afterwards would let the model summarize updates that are about to
   * be deleted and make changedBecause's `updates:+N` a count of events on
   * their way out of the file. Hoisting the loop out of the mode guard keeps
   * that order exactly — prune, then (nightly only) summarize.
   * --------------------------------------------------------------------- */
  for (const momentId of pruneStore(store, moments, { now, mode: MODE })) {
    console.log(`prune: ${momentId} entry deleted (moment retired or removed)`);
  }

  // ---- nightly: summarize ----
  if (MODE === 'nightly') {
    let summaries = 0;
    for (const [momentId, moment] of Object.entries(moments)) {
      if (moment?.status === 'retired') continue;
      if (summaries >= SUMMARY_DAILY_CAP) break;
      const entry = store[momentId];
      if (!entry) continue;

      const statuses = {};
      // The record each status is read against — the two halves statusKeyFor
      // needs to tell a live calendar placement from an aged one. Deliberately
      // a SECOND map: `statuses` is persisted verbatim in the revision's
      // grounded_in and diffed by summaryNeedsRefresh, so nothing here may
      // change its shape.
      const records = {};
      for (const v of moment.vehicles ?? []) {
        const bill = billBySlug.get(v.slug);
        if (!bill?.status) continue;
        statuses[v.slug] = bill.status;
        records[v.slug] = {
          lastActionText: bill.last_action_text ?? null,
          lastActionDate: bill.last_action_date ?? null,
        };
      }
      if (Object.keys(statuses).length === 0) continue;
      if (!summaryNeedsRefresh(entry, statuses, now)) {
        console.log(`  summary ${momentId}: nothing moved — not regenerated`);
        continue;
      }
      if (!anthropic) {
        console.warn(`  summary ${momentId}: needs a refresh but ANTHROPIC_API_KEY is unset — skipped`);
        continue;
      }
      const contextRefs = (moment.context_refs ?? []).map((r) => r?.url).filter(Boolean);
      const revision = await generateStateSummary(anthropic, momentId, entry, statuses, contextRefs, records);
      if (!revision) continue;
      // Belt and braces. The reserveRevisions above is the belt — it holds the
      // slot this append needs. This slice is the braces: if a second append
      // path is ever added, or the prune is ever skipped for a moment this
      // loop still reaches, the cap the CI gate enforces still holds at the
      // only line that grows the array.
      entry.summary_revisions = [...(entry.summary_revisions ?? []), revision].slice(-MAX_REVISIONS);
      summaries++;
      console.log(`  summary ${momentId}: ${revision.id} (${revision.changed_because.join(', ')})`);
    }
    console.log(`summaries: ${summaries} revision(s) written (cap ${SUMMARY_DAILY_CAP})`);
  }

  // ---- write ----
  const entries = Object.fromEntries(Object.entries(store).filter(([k]) => k !== '_meta'));
  writeIfChanged(entries, originalText);
}

/*
 * Run-directly guard, the same shape scripts/moment-candidates.mjs uses and
 * for the same reason: argv[1] is this file when node executes it, and the
 * Playwright CLI when tests/moment-updates-runner.unit.spec.ts imports it.
 * The guard alone would not be enough — every module-scope read of data/ and
 * the Anthropic client moved inside main() too, so a bare import does no I/O.
 *
 * Anchored on the path separator rather than a bare endsWith: this repo also
 * ships scripts/check-moment-updates.mjs, whose filename ENDS WITH this one's,
 * so an unanchored suffix test is a collision waiting to happen.
 *
 * NOT `await main()`, deliberately: a top-level await anywhere in this module
 * makes it un-`require()`-able, and Playwright's transform requires it. The
 * explicit .catch keeps what the old top-level await gave us — the stack on
 * stderr and a non-zero exit — without the top-level await itself.
 */
if (/(^|\/)moment-updates\.mjs$/.test(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
