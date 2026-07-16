/**
 * Nightly bill sync. Static-first pipeline: updates data/*.json from
 * Congress.gov + Anthropic, then CI commits the diff and Vercel redeploys.
 *
 *   node --env-file=.env.local scripts/sync-bills.mjs
 *
 * Needs CONGRESS_API_KEY + ANTHROPIC_API_KEY.
 *
 * Policy:
 * - Existing bills: status/action/urgency/tags refresh freely (no AI cost).
 * - NEW bills are decode-before-publish: they enter the corpus only once
 *   their EN+ES summary and headline exist, so the feed never shows
 *   undecoded entries. At most MAX_NEW_DECODES per run (cost ceiling);
 *   the rest wait for the next night.
 *
 * Two-pass fetch (2026-07-16, audit §5 item 2). Congress.gov is queried
 * TWICE per run, in this order:
 *   1. Recent-first: `sort=updateDate+desc, limit=RECENT_FETCH_LIMIT` - the
 *      ~100 most-recently-touched bills in the whole 119th Congress, no
 *      cursor floor. Already-known bills refresh for free; brand-new bills
 *      decode within a RESERVED sub-budget (RECENT_DECODE_RESERVE, carved
 *      OUT of MAX_NEW_DECODES, not additional). This exists because the
 *      ascending backlog scan below structurally reaches the newest bills
 *      LAST - on a night with a deep backlog (or a busy legislative day) a
 *      floor vote that just happened would otherwise lose the race against
 *      both MAX_UPDATES and MAX_NEW_DECODES every single night, which is
 *      exactly how HR 7378 (and the whole "worth a call" feed) went stale
 *      for weeks even on clean, successful runs (see the audit).
 *   2. Ascending backlog: `fromDateTime: lastSync, sort=updateDate+asc` -
 *      unchanged from before, drains the historical backlog oldest-first
 *      with whatever decode budget the recent-first pass didn't use. A bill
 *      already handled by pass 1 this run is skipped here (deduped, not
 *      re-fetched or re-decoded).
 *
 * CURSOR SEMANTICS (load-bearing, KTD-pinned): `state.lastSync`'s freeze-
 * on-incomplete-work high-water mark is advanced ONLY by the ascending pass
 * below. The recent-first pass never reads or writes `cursor`/`frozen` - it
 * can find and decode a bill from last week while the ascending backlog is
 * still stuck in May, and the cursor must keep meaning "the backlog scan has
 * fully processed through here", not silently jump forward just because a
 * recent bill happened to get handled out of order. See
 * docs/solutions/pinned-sync-cursor.md for why an all-or-nothing cursor is
 * exactly the failure this preserves the fix for.
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  BILL_TYPES,
  CONGRESS,
  cg,
  fetchRecentlyUpdated,
  mapStatus,
  refreshBillFields,
  slugOf,
  tagBill,
  updateSlug,
  urgencyScore,
} from './congress-fetch.mjs';
import { generateSearchInputs } from './search-inputs.mjs';

const MAX_UPDATES = Number(process.env.MAX_UPDATES ?? 500);
// Raised 40 -> 120 (2026-07-16, audit §5 item 1): live nightly logs showed
// 373-418 bills/night needing decode against a 40-bill budget, pinning the
// ascending-pass cursor (state.lastSync) weeks behind and starving newer
// bills of decode slots night after night. 120 doesn't fully clear that
// inflow alone (~$8-14/night at $0.07-0.15/bill) - see the two-pass fetch
// design note above for the fix that stops recency from losing the race
// structurally, independent of how large the budget is.
const MAX_NEW_DECODES = Number(process.env.MAX_NEW_DECODES ?? 120);
// The recent-first pass's fetch window (audit §5 item 2 / §4 Alt A) - same
// rough size as the twice-daily hot-bills.mjs refresh pass.
const RECENT_FETCH_LIMIT = Number(process.env.RECENT_FETCH_LIMIT ?? 100);
// New-bill decode budget RESERVED for the recent-first pass, carved out of
// (not additional to) MAX_NEW_DECODES - a night with zero brand-new bills in
// the last ~100 updates leaves the full MAX_NEW_DECODES for the ascending
// backlog pass; a night with several leaves proportionally less.
const RECENT_DECODE_RESERVE = Number(process.env.RECENT_DECODE_RESERVE ?? 20);

const anthropic = new Anthropic({ maxRetries: 8 });
// Sonnet 5's tokenizer runs ~30% more tokens than 4.6 for the same text, so
// max_tokens caps on its calls are sized up accordingly; thinking is disabled
// explicitly because Sonnet 5 defaults it ON when the field is omitted, which
// would add unbounded thinking spend to batch calls.
const MODEL = 'claude-sonnet-5';

const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
const es = JSON.parse(readFileSync('data/bills-es.json', 'utf8'));
const state = JSON.parse(readFileSync('data/sync-state.json', 'utf8'));
const bySlug = new Map(bills.map((b) => [slugOf(b), b]));

// Congress.gov's bill-list `updateDate` field is date-only (e.g. "2026-06-04"),
// not a full timestamp. Persisting it as-is breaks the next run's fromDateTime
// query, which Congress.gov 400s on - the 2026-06-25/07-01 outage. Always
// normalize to a full ISO-8601 datetime before it becomes the next cursor.
function toISODateTime(d) {
  return /T/.test(d) ? d : `${d}T00:00:00Z`;
}

// ---- AI decode (new bills only) ----
async function fetchBillText(type, number) {
  const data = await cg(`/bill/${CONGRESS}/${type}/${number}/text`);
  const versions = data.textVersions ?? [];
  for (const v of [...versions].reverse()) {
    const fmt = (v.formats ?? []).find((f) => f.type === 'Formatted Text');
    if (fmt?.url) {
      const res = await fetch(fmt.url);
      if (!res.ok) continue;
      const html = await res.text();
      return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60_000);
    }
  }
  return null;
}

const DECODE_TAGS = [
  'HEADLINE_EN', 'HEADLINE_ES',
  'TLDR', 'WHAT', 'WHO', 'WHY', 'COST', 'COST_CHIPS',
  'ES_TLDR', 'ES_WHAT', 'ES_WHO', 'ES_WHY', 'ES_COST', 'ES_COST_CHIPS', 'ES_SUMMARY',
];

function parseTagged(text) {
  const out = {};
  for (let i = 0; i < DECODE_TAGS.length; i++) {
    const tag = DECODE_TAGS[i];
    const start = text.indexOf(`[${tag}]`);
    if (start === -1) throw new Error(`missing [${tag}]`);
    const next = DECODE_TAGS.slice(i + 1)
      .map((t) => text.indexOf(`[${t}]`))
      .filter((x) => x > start);
    const end = next.length ? Math.min(...next) : text.length;
    out[tag] = text.slice(start + tag.length + 2, end).trim();
  }
  return out;
}

const normCost = (s) => (s === 'NONE' || !s ? null : s);

function normChips(s) {
  if (s === 'NONE' || !s) return null;
  const chips = s.split('|').map((c) => c.trim()).filter(Boolean);
  if (chips.length < 1 || chips.length > 3 || chips.some((c) => c.length > 48)) return null;
  return chips;
}

async function decode(bill, text) {
  const sum = await anthropic.messages.create({
    model: MODEL, max_tokens: 900, thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: `Explain this congressional bill in plain language for an everyday US resident (8th-grade reading level). 2-3 short paragraphs: what it actually does, and who it affects. Strictly nonpartisan, no advocacy, no preamble, no markdown.

Bill: ${bill.bill_type.toUpperCase()} ${bill.bill_number} — ${bill.title}

Full text (may be truncated):
${text ?? bill.title}` }],
  });
  const ai_summary = sum.content[0].text.trim();

  const rest = await anthropic.messages.create({
    model: MODEL, max_tokens: 3250, thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: `From this plain-language bill summary, produce headlines, scannable sections, and a Spanish translation.

Bill: ${bill.bill_type.toUpperCase()} ${bill.bill_number}
Summary:
${ai_summary}

STRICT RULES:
- Use ONLY facts present in the summary. Never invent numbers, costs, or claims.
- Headlines: 45-90 chars, sentence case, factual news-desk style, varied construction (NOT "Topic — Consequence", avoid colons), never start with "Congress". Prioritize the most decision-relevant specifics: what it does, who it affects, what it costs, or where it stands.
- TLDR: one sentence, max 160 chars, the single most decision-relevant fact.
- WHAT: 1-3 sentences. WHO: 1-2. WHY: 1-2 sentences of neutral consequence, never benefits-framing.
- COST: 1-2 sentences ONLY if the summary contains spending/funding/fines/who-pays content; otherwise output exactly NONE (and ES_COST, COST_CHIPS, ES_COST_CHIPS all NONE too).
- COST_CHIPS: when COST exists, compress it to 2-3 chips separated by " | ", each a standalone fact fragment max 45 chars, sentence case, no period. Same count and order in ES_COST_CHIPS. If a fact can't fit 45 chars, output NONE for both chip tags (prose is the fallback).
- Spanish: natural Latin American Spanish, 8th-grade level; citations/numbers exact; agency names in English with a short gloss when helpful. ES_SUMMARY is the full summary translation.
- Plain text, no markdown.

Output exactly this tagged format, each tag on its own line followed by its content:
[HEADLINE_EN]
[HEADLINE_ES]
[TLDR]
[WHAT]
[WHO]
[WHY]
[COST]
[COST_CHIPS]
[ES_TLDR]
[ES_WHAT]
[ES_WHO]
[ES_WHY]
[ES_COST]
[ES_COST_CHIPS]
[ES_SUMMARY]` }],
  });
  const p = parseTagged(rest.content[0].text.trim());
  if (!p.HEADLINE_EN || !p.TLDR || !p.WHAT || !p.WHO || !p.WHY || !p.ES_SUMMARY) {
    throw new Error('bad decode shape');
  }
  return {
    ai_summary,
    ai_headline: p.HEADLINE_EN.slice(0, 110),
    ai_sections: {
      tldr: p.TLDR, what: p.WHAT, who: p.WHO, why: p.WHY,
      cost: normCost(p.COST), costChips: normChips(p.COST_CHIPS),
    },
    es_headline: p.HEADLINE_ES.slice(0, 110),
    es_summary: p.ES_SUMMARY,
    es_sections: {
      tldr: p.ES_TLDR, what: p.ES_WHAT, who: p.ES_WHO, why: p.ES_WHY,
      cost: normCost(p.ES_COST), costChips: normChips(p.ES_COST_CHIPS),
    },
  };
}

// ---- main ----
const since = state.lastSync;
const runStart = new Date().toISOString();
console.log(`sync since ${since}`);

// Shared new-bill decode-budget counter - both passes below decrement into
// this ONE pool (RECENT_DECODE_RESERVE is a ceiling on the recent-first
// pass's share of it, not a separate allowance; see the header comment).
let added = 0;
let refreshed = 0; // combined total across both passes (log-only, not gated)

/**
 * Fetch one bill's current detail and either refresh it (already in the
 * corpus - free) or decode it as new (only if `allowDecode`). The one place
 * both passes below do "turn a Congress.gov update item into a corpus
 * mutation", so the decode-before-publish invariant and the refresh fields
 * can't drift between the recent-first pass and the ascending backlog pass.
 * Returns one of:
 *   'refreshed' - an existing bill's fields were updated in place
 *   'added'     - a brand-new bill was decoded and pushed into the corpus
 *   'budget'    - a brand-new bill was found but `allowDecode` was false
 *   'failed'    - the fetch or decode threw; `isNew` tells the caller
 *                 whether this was a new-bill decode failure (must retry)
 *                 or an existing bill's transient refresh failure
 *                 (idempotent, self-heals on its next update).
 */
async function syncOneBill(u, allowDecode) {
  const type = u.type.toLowerCase();
  const slug = updateSlug(u);
  try {
    const { bill: d } = await cg(`/bill/${CONGRESS}/${type}/${u.number}`);
    const existing = bySlug.get(slug);
    if (existing) {
      refreshBillFields(existing, d);
      return { outcome: 'refreshed', slug };
    }
    if (!allowDecode) return { outcome: 'budget', slug };
    const status = mapStatus(d.latestAction?.text);
    const lastActionDate = d.latestAction?.actionDate ?? null;
    const bill = {
      full_identifier: slug,
      congress_number: CONGRESS,
      bill_type: type,
      bill_number: Number(u.number),
      title: d.title,
      short_title: null,
      ai_summary: null, ai_headline: null,
      sponsor_bioguide_id: d.sponsors?.[0]?.bioguideId ?? null,
      introduced_date: d.introducedDate ?? null,
      last_action_date: lastActionDate,
      last_action_text: d.latestAction?.text ?? null,
      status,
      issue_tags: tagBill(d.policyArea?.name),
      policy_area: d.policyArea?.name ?? null,
      urgency_score: urgencyScore(status, lastActionDate),
      congress_gov_url: `https://www.congress.gov/bill/${CONGRESS}th-congress/${type === 'hr' ? 'house-bill' : type === 's' ? 'senate-bill' : type === 'hjres' ? 'house-joint-resolution' : 'senate-joint-resolution'}/${u.number}`,
    };
    const text = await fetchBillText(type, u.number);
    const dec = await decode(bill, text);
    bill.ai_summary = dec.ai_summary;
    bill.ai_headline = dec.ai_headline;
    bill.ai_sections = dec.ai_sections;
    // Search handles for the coverage sync (press names + subject query).
    // Non-fatal: the backfill script sweeps up any misses.
    try {
      const si = await generateSearchInputs(anthropic, bill);
      bill.press_names = si.press_names;
      bill.news_query = si.news_query;
    } catch (e) {
      console.error(`  search-inputs failed for ${slug}: ${e.message}`);
    }
    es[slug] = { headline: dec.es_headline, summary: dec.es_summary, sections: dec.es_sections };
    bills.push(bill);
    bySlug.set(slug, bill);
    return { outcome: 'added', slug };
  } catch (e) {
    console.error(`FAIL ${slug}: ${e.message}`);
    return { outcome: 'failed', slug, isNew: !bySlug.has(slug) };
  }
}

// ---- Pass 1: recent-first (audit §5 item 2) ----------------------------
// Guarantees this run always sees the most recently-touched bills in
// Congress, no matter how deep the ascending backlog is. `handledSlugs`
// tracks everything this pass successfully resolved so pass 2 can dedupe
// without re-fetching or re-decoding - see updateSlug/refreshBillFields.
const handledSlugs = new Set();
const recentDecodeCap = Math.min(RECENT_DECODE_RESERVE, MAX_NEW_DECODES);
console.log(`recent-first pass: fetching up to ${RECENT_FETCH_LIMIT} most-recently-updated bills (decode reserve ${recentDecodeCap})`);
const recentBills = await fetchRecentlyUpdated(RECENT_FETCH_LIMIT);
let recentRefreshed = 0, recentAdded = 0, recentDeferred = 0, recentFailed = 0;
for (const u of recentBills) {
  const result = await syncOneBill(u, added < recentDecodeCap);
  if (result.outcome === 'refreshed') {
    refreshed++; recentRefreshed++; handledSlugs.add(result.slug);
  } else if (result.outcome === 'added') {
    added++; recentAdded++; handledSlugs.add(result.slug);
  } else if (result.outcome === 'budget') {
    recentDeferred++; // new bill, reserve exhausted - left for pass 2 (same run) or next run
  } else {
    recentFailed++; // logged only; deliberately NOT folded into the abort check below
  }
}
console.log(`recent-first pass: ${recentRefreshed} refreshed, ${recentAdded} added+decoded, ${recentDeferred} deferred (reserve exhausted), ${recentFailed} failed`);

// ---- Pass 2: ascending backlog scan from the cursor ---------------------
// Unchanged shape from before the two-pass fetch - see the header comment.
// The freeze-on-incomplete-work cursor logic below is tied ONLY to this
// pass; pass 1 above never touches `cursor`/`frozen`.
const updated = [];
let offset = 0;
for (;;) {
  const page = await cg(`/bill/${CONGRESS}`, {
    fromDateTime: since, sort: 'updateDate+asc', limit: 250, offset,
  });
  const items = page.bills ?? [];
  updated.push(...items.filter((b) => BILL_TYPES.has((b.type ?? '').toLowerCase())));
  offset += 250;
  if (!page.pagination?.next || updated.length >= MAX_UPDATES) break;
}
console.log(`${updated.length} updated bills (capped at ${MAX_UPDATES})`);

let queued = 0, failed = 0;
// High-water mark: advance the cursor over every bill we fully handle, and
// freeze it the instant we hit one that still needs work (decode budget
// exhausted, or a new bill whose decode failed). A transient *refresh* failure
// on a bill already in the corpus is idempotent and self-heals on its next
// update, so it doesn't freeze us - the old all-or-nothing freeze is what
// pinned lastSync for weeks and turned every run into a full window re-scan.
let cursor = since;
let frozen = false;
for (const u of updated.slice(0, MAX_UPDATES)) {
  const slug = updateSlug(u);
  let needsWork = false;
  if (handledSlugs.has(slug)) {
    // Already fully resolved by the recent-first pass this run - dedupe,
    // don't re-fetch/re-decode. Resolved is resolved, so the cursor may
    // still advance over it exactly as if pass 2 had handled it itself.
  } else {
    const result = await syncOneBill(u, added < MAX_NEW_DECODES);
    if (result.outcome === 'refreshed') {
      refreshed++;
    } else if (result.outcome === 'added') {
      added++;
    } else if (result.outcome === 'budget') {
      queued++; // decode budget exhausted; revisit next run
      needsWork = true;
    } else {
      failed++;
      // A new bill that failed to decode must be retried; a failed refresh of
      // a known bill is idempotent and re-touches on its next update.
      if (result.isNew) needsWork = true;
    }
  }
  if (needsWork) frozen = true;
  else if (!frozen && u.updateDate) cursor = toISODateTime(u.updateDate);
}

// Clean run (nothing left behind) advances to runStart; otherwise advance to
// the high-water mark so we still make forward progress instead of re-scanning
// the same window forever.
state.lastSync = frozen ? cursor : runStart;
state.lastRun = runStart;

writeFileSync('data/bills.json', JSON.stringify(bills));
writeFileSync('data/bills-es.json', JSON.stringify(es));
writeFileSync('data/sync-state.json', JSON.stringify(state, null, 2));
console.log(`DONE: ${refreshed} refreshed, ${added} added+decoded, ${queued} queued for next run, ${failed} failed; corpus ${bills.length}`);
// Mostly-failed run: don't let CI commit garbage. Scoped to the ascending
// pass's own failed/updated.length exactly as before the two-pass fetch -
// the recent-first pass's (much smaller, logged-separately) failures don't
// feed this check.
if (failed > updated.length / 2) process.exit(1);
