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
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { STATUS_BASE } from '../lib/urgency.mjs';
import { generateSearchInputs } from './search-inputs.mjs';

const CONGRESS = 119;
const BILL_TYPES = new Set(['hr', 's', 'hjres', 'sjres']);
const MAX_UPDATES = Number(process.env.MAX_UPDATES ?? 500);
const MAX_NEW_DECODES = Number(process.env.MAX_NEW_DECODES ?? 40);
const API = 'https://api.congress.gov/v3';
const KEY = process.env.CONGRESS_API_KEY;
if (!KEY) throw new Error('CONGRESS_API_KEY missing');

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

function slugOf(b) {
  return `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
}

// Congress.gov's bill-list `updateDate` field is date-only (e.g. "2026-06-04"),
// not a full timestamp. Persisting it as-is breaks the next run's fromDateTime
// query, which Congress.gov 400s on - the 2026-06-25/07-01 outage. Always
// normalize to a full ISO-8601 datetime before it becomes the next cursor.
function toISODateTime(d) {
  return /T/.test(d) ? d : `${d}T00:00:00Z`;
}

async function cg(path, params = {}) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('api_key', KEY);
  url.searchParams.set('format', 'json');
  let lastErr;
  for (let attempt = 0; attempt <= 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      // 30s per-request ceiling: a hung socket fails fast and retries instead
      // of hanging on undici's ~5min headers timeout (the 2026-06-13 crash).
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      // await inside the try: the 30s abort can fire mid-body-read, and an
      // un-awaited res.json() rejection would escape the catch and kill the
      // run uncaught instead of retrying (the 2026-07-04 crash).
      if (res.ok) return await res.json();
      lastErr = new Error(`Congress.gov ${res.status} for ${path}`);
    } catch (e) {
      lastErr = e; // network error / timeout - retry rather than kill the run
    }
  }
  throw lastErr;
}

// ---- status mapping (ported from the reference implementation) ----
function mapStatus(actionText) {
  const text = (actionText ?? '').toLowerCase().trim();
  if (!text) return 'committee';
  if (text.includes('became public law') || text.includes('signed by president')) return 'signed';
  if (text.includes('vetoed')) return 'vetoed';
  if (text.includes('conference report') || text.includes('conference committee')) return 'conference';
  if (
    text.includes('passed house') || text.includes('passed senate') ||
    text.includes('passed/agreed to') || text.includes('agreed to in') ||
    text.includes('received in the senate') || text.includes('received in the house') ||
    text.includes('held at the desk')
  ) return 'passed_chamber';
  if (
    text.includes('placed on') || text.includes('calendar') ||
    text.includes('cloture') || text.includes('rule provid') ||
    text.includes('motion to proceed')
  ) return 'floor_vote';
  if (text.includes('markup') || text.includes('ordered to be reported') || text.includes('reported by')) return 'markup';
  return 'committee';
}

// Stored sync-time score (freshness bonus, no decay) - the FEED never ranks
// by this; read-time effectiveUrgency in lib/urgency.mjs does the ranking.
// The base table is shared so the two curves can't drift apart.
function urgencyScore(status, lastActionDate) {
  const base = STATUS_BASE[status] ?? 0.2;
  let bonus = 0;
  if (lastActionDate) {
    const days = (Date.now() - new Date(lastActionDate).getTime()) / 86_400_000;
    if (Number.isFinite(days)) bonus = days < 3 ? 0.1 : days < 7 ? 0.05 : 0;
  }
  return Math.round(Math.min(1, Math.max(0, base + bonus)) * 1000) / 1000;
}

// CRS Policy Area -> our 12 flat categories (1:1, all 32 areas covered)
const POLICY_AREA_TO_CATEGORY = {
  'Labor and Employment': 'jobs_economy', 'Commerce': 'jobs_economy',
  'Finance and Financial Sector': 'jobs_economy', 'Taxation': 'jobs_economy',
  'Economics and Public Finance': 'jobs_economy', 'Agriculture and Food': 'jobs_economy',
  'Transportation and Public Works': 'jobs_economy',
  'Science, Technology, Communications': 'ai_technology',
  'Health': 'health',
  'Housing and Community Development': 'housing',
  'Immigration': 'immigration',
  'Government Operations and Politics': 'government_democracy', 'Congress': 'government_democracy',
  'Emergency Management': 'government_democracy',
  'Crime and Law Enforcement': 'crime_justice', 'Law': 'crime_justice',
  'Education': 'education', 'Sports and Recreation': 'education',
  'Social Sciences and History': 'education',
  'Environmental Protection': 'environment_energy', 'Energy': 'environment_energy',
  'Public Lands and Natural Resources': 'environment_energy',
  'Water Resources Development': 'environment_energy', 'Animals': 'environment_energy',
  'Civil Rights and Liberties, Minority Issues': 'rights_liberties',
  'Armed Forces and National Security': 'national_security',
  'International Affairs': 'national_security',
  'Foreign Trade and International Finance': 'national_security',
  'Families': 'family_community', 'Social Welfare': 'family_community',
  'Native Americans': 'family_community', 'Arts, Culture, Religion': 'family_community',
};

function tagBill(policyArea) {
  const cat = POLICY_AREA_TO_CATEGORY[policyArea ?? ''];
  return cat ? [cat] : [];
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

let refreshed = 0, added = 0, queued = 0, failed = 0;
// High-water mark: advance the cursor over every bill we fully handle, and
// freeze it the instant we hit one that still needs work (decode budget
// exhausted, or a new bill whose decode failed). A transient *refresh* failure
// on a bill already in the corpus is idempotent and self-heals on its next
// update, so it doesn't freeze us - the old all-or-nothing freeze is what
// pinned lastSync for weeks and turned every run into a full window re-scan.
let cursor = since;
let frozen = false;
for (const u of updated.slice(0, MAX_UPDATES)) {
  const type = u.type.toLowerCase();
  const slug = `${type}-${u.number}-${CONGRESS}`;
  let needsWork = false;
  try {
    const { bill: d } = await cg(`/bill/${CONGRESS}/${type}/${u.number}`);
    const status = mapStatus(d.latestAction?.text);
    const lastActionDate = d.latestAction?.actionDate ?? null;
    const existing = bySlug.get(slug);
    if (existing) {
      existing.status = status;
      existing.last_action_date = lastActionDate;
      existing.last_action_text = d.latestAction?.text ?? existing.last_action_text;
      existing.urgency_score = urgencyScore(status, lastActionDate);
      const tags = tagBill(d.policyArea?.name);
      if (tags.length) existing.issue_tags = tags;
      existing.policy_area = d.policyArea?.name ?? existing.policy_area;
      refreshed++;
    } else if (added < MAX_NEW_DECODES) {
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
      added++;
    } else {
      queued++; // decode budget exhausted; revisit next run
      needsWork = true;
    }
  } catch (e) {
    failed++;
    console.error(`FAIL ${slug}: ${e.message}`);
    // A new bill that failed to decode must be retried; a failed refresh of a
    // known bill is idempotent and re-touches on its next update.
    if (!bySlug.has(slug)) needsWork = true;
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
if (failed > updated.length / 2) process.exit(1); // mostly-failed run: don't let CI commit garbage
