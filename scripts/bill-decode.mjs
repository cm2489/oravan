/**
 * Shared decode-before-publish + priority-gate resolution for ONE bill,
 * used by BOTH scripts/sync-bills.mjs (nightly recent-first + ascending-
 * backlog passes) and scripts/newsdesk.mjs (hourly headline-triggered
 * resync, Part 2 of the 2026-07-16 spend-reduction pair). One copy so the
 * gate, the FORCE_DECODE_SLUGS bypass, and the actual decode-before-publish
 * AI calls can't drift between callers — same "one copy" discipline as
 * lib/urgency.mjs's STATUS_BASE and congress-fetch.mjs's refreshBillFields.
 *
 * Extracted 2026-07-16 from what was previously sync-bills.mjs's own
 * module-scope decode() + syncOneBill(): moving these here (as functions
 * that take bills/es/bySlug/anthropic explicitly rather than closing over
 * module-scope state) is what lets scripts/newsdesk.mjs decode a
 * press-triggered new bill via the EXACT SAME decode-before-publish path
 * the nightly sync uses, instead of maintaining a second copy of the
 * summary/headline/ES prompts that could drift.
 */
import { readFileSync } from 'node:fs';
import {
  CONGRESS,
  cg,
  mapStatus,
  refreshBillFields,
  tagBill,
  updateSlug,
  urgencyScore,
} from './congress-fetch.mjs';
import { passesGate } from './decode-gate.mjs';
import { generateSearchInputs } from './search-inputs.mjs';

// Sonnet 5's tokenizer runs ~30% more tokens than 4.6 for the same text, so
// max_tokens caps on its calls are sized up accordingly; thinking is disabled
// explicitly because Sonnet 5 defaults it ON when the field is omitted, which
// would add unbounded thinking spend to batch calls.
export const DECODE_MODEL = 'claude-sonnet-5';

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

async function decode(anthropic, bill, text) {
  const sum = await anthropic.messages.create({
    model: DECODE_MODEL, max_tokens: 900, thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: `Explain this congressional bill in plain language for an everyday US resident (8th-grade reading level). 2-3 short paragraphs: what it actually does, and who it affects. Strictly nonpartisan, no advocacy, no preamble, no markdown.

Bill: ${bill.bill_type.toUpperCase()} ${bill.bill_number} — ${bill.title}

Full text (may be truncated):
${text ?? bill.title}` }],
  });
  const ai_summary = sum.content[0].text.trim();

  const rest = await anthropic.messages.create({
    model: DECODE_MODEL, max_tokens: 3250, thinking: { type: 'disabled' },
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

/**
 * Fetch one bill's current detail and either refresh it (already in the
 * corpus — free, unconditional) or, for a brand-new bill, run it through
 * the priority gate and decode-before-publish. The ONE place both
 * sync-bills.mjs's passes and newsdesk.mjs's trigger path turn a
 * Congress.gov update item ({type, number}) into a corpus mutation, so the
 * gate, the force-bypass, and the refresh fields can't drift between
 * callers.
 *
 * `u` is `{type, number}` (Congress.gov's shape, or newsdesk.mjs's own
 * slug-derived equivalent). `ctx`:
 *   - allowDecode: this call may spend a decode if it clears the gate
 *     (the caller's own budget bookkeeping — MAX_NEW_DECODES for
 *     sync-bills.mjs, NEWSDESK_DECODE_CAP for newsdesk.mjs).
 *   - forceSlugs: a Set of slugs that bypass the priority gate entirely
 *     (still subject to allowDecode). Populated from FORCE_DECODE_SLUGS
 *     for manual/workflow_dispatch runs, or built in-process by
 *     newsdesk.mjs from headline-triggered bills — see decode-gate.mjs.
 *   - bills, es, bySlug, anthropic: the caller's loaded corpus + client.
 *
 * Returns one of:
 *   'refreshed' — an existing bill's fields were updated in place (free)
 *   'added'     — a brand-new bill was decoded and pushed into the corpus
 *   'gated'     — a brand-new bill was found but shows no real legislative
 *                 motion (and isn't force-bypassed) — NOT stored anywhere.
 *                 Fully handled: if it later moves, Congress.gov's own
 *                 updateDate advances past the caller's cursor and the
 *                 update feed resurfaces it on a future run, when the gate
 *                 re-evaluates against its then-current status.
 *   'budget'    — a brand-new bill cleared the gate (or was forced) but
 *                 `allowDecode` was false this call
 *   'failed'    — the fetch or decode threw; `isNew` tells the caller
 *                 whether this was a new-bill decode failure (must retry)
 *                 or an existing bill's transient refresh failure
 *                 (idempotent, self-heals on its next update).
 */
export async function syncOneBill(u, ctx) {
  const { allowDecode, forceSlugs = new Set(), bills, es, bySlug, anthropic } = ctx;
  const type = u.type.toLowerCase();
  const slug = updateSlug(u);
  try {
    const { bill: d } = await cg(`/bill/${CONGRESS}/${type}/${u.number}`);
    const existing = bySlug.get(slug);
    if (existing) {
      refreshBillFields(existing, d);
      return { outcome: 'refreshed', slug };
    }
    const status = mapStatus(d.latestAction?.text);
    const forced = forceSlugs.has(slug);
    if (!forced && !passesGate(status)) {
      return { outcome: 'gated', slug, status };
    }
    if (!allowDecode) return { outcome: 'budget', slug };
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
    const dec = await decode(anthropic, bill, text);
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

/** Read+parse a data/*.json file — tiny shared helper so both callers open
 *  the corpus the same way. */
export function loadJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
