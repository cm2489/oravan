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

const CONGRESS = 119;
const BILL_TYPES = new Set(['hr', 's', 'hjres', 'sjres']);
const MAX_UPDATES = Number(process.env.MAX_UPDATES ?? 500);
const MAX_NEW_DECODES = Number(process.env.MAX_NEW_DECODES ?? 40);
const API = 'https://api.congress.gov/v3';
const KEY = process.env.CONGRESS_API_KEY;
if (!KEY) throw new Error('CONGRESS_API_KEY missing');

const anthropic = new Anthropic({ maxRetries: 8 });
const MODEL = 'claude-sonnet-4-6';

const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
const es = JSON.parse(readFileSync('data/bills-es.json', 'utf8'));
const state = JSON.parse(readFileSync('data/sync-state.json', 'utf8'));
const bySlug = new Map(bills.map((b) => [slugOf(b), b]));

function slugOf(b) {
  return `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
}

async function cg(path, params = {}) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('api_key', KEY);
  url.searchParams.set('format', 'json');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (attempt >= 4) throw new Error(`Congress.gov ${res.status} for ${path}`);
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
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

function urgencyScore(status, lastActionDate) {
  const base = {
    floor_vote: 0.9, passed_chamber: 0.75, conference: 0.75, markup: 0.65,
    committee: 0.45, signed: 0.3, vetoed: 0.3, introduced: 0.2,
  }[status] ?? 0.2;
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

async function decode(bill, text) {
  const sum = await anthropic.messages.create({
    model: MODEL, max_tokens: 700,
    messages: [{ role: 'user', content: `Explain this congressional bill in plain language for an everyday US resident (8th-grade reading level). 2-3 short paragraphs: what it actually does, and who it affects. Strictly nonpartisan, no advocacy, no preamble, no markdown.

Bill: ${bill.bill_type.toUpperCase()} ${bill.bill_number} — ${bill.title}

Full text (may be truncated):
${text ?? bill.title}` }],
  });
  const ai_summary = sum.content[0].text.trim();

  const rest = await anthropic.messages.create({
    model: MODEL, max_tokens: 900,
    messages: [{ role: 'user', content: `From this plain-language bill summary, produce three things.

Summary:
${ai_summary}

1. An English headline: 45-90 chars, sentence case, factual news-desk style, name the specific agency/rule/program, varied construction (NOT "Topic — Consequence", avoid colons), never start with "Congress".
2. A Spanish headline: same rules, a natural headline in its own right.
3. A Spanish translation of the full summary: natural Latin American Spanish, 8th-grade level, keep citations/numbers exact, US agency names in English with a short Spanish gloss when helpful.

Output exactly:
line 1: English headline
line 2: Spanish headline
line 3: ===
then the Spanish summary.` }],
  });
  const out = rest.content[0].text.trim();
  const [head, body] = out.split('===');
  const lines = head.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 || !body?.trim()) throw new Error('bad decode shape');
  return {
    ai_summary,
    ai_headline: lines[0].slice(0, 110),
    es_headline: lines[1].slice(0, 110),
    es_summary: body.trim(),
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
for (const u of updated.slice(0, MAX_UPDATES)) {
  const type = u.type.toLowerCase();
  const slug = `${type}-${u.number}-${CONGRESS}`;
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
      es[slug] = { headline: dec.es_headline, summary: dec.es_summary };
      bills.push(bill);
      bySlug.set(slug, bill);
      added++;
    } else {
      queued++; // decode budget exhausted; picked up next run (lastSync won't advance past failures - see below)
    }
  } catch (e) {
    failed++;
    console.error(`FAIL ${slug}: ${e.message}`);
  }
}

// Advance the cursor only when nothing was left behind; otherwise re-scan
// the same window next run (refresh is idempotent, decode is skip-if-known).
state.lastSync = queued || failed ? state.lastSync : runStart;
state.lastRun = runStart;

writeFileSync('data/bills.json', JSON.stringify(bills));
writeFileSync('data/bills-es.json', JSON.stringify(es));
writeFileSync('data/sync-state.json', JSON.stringify(state, null, 2));
console.log(`DONE: ${refreshed} refreshed, ${added} added+decoded, ${queued} queued for next run, ${failed} failed; corpus ${bills.length}`);
if (failed > updated.length / 2) process.exit(1); // mostly-failed run: don't let CI commit garbage
