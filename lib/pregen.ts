import { billSlug } from './core/bills';
import { contentVersion } from './scriptcache';
import { buildScriptPrompt, SCRIPT_MAX_TOKENS, SCRIPT_MODEL } from './scriptprompt';
import type { Bill, Stance } from './types';

/*
 * Pure planning/estimation logic for scripts/pregen-scripts.mjs (S21, F7).
 * Kept dependency-free of Anthropic/Upstash I/O (same split as
 * lib/salt.mjs vs scripts/verify-salt.mjs) so it's directly unit-testable
 * without mocking a network client.
 */

export const LOCALES: Array<'en' | 'es'> = ['en', 'es'];

export interface Combo {
  slug: string;
  stance: Stance;
  lang: 'en' | 'es';
  version: string;
  /** Always the raw (English) bill — see lib/scriptprompt.ts's module note. */
  bill: Bill;
}

/** Every (bill x stance x locale) combo for a shortlist of bills. */
export function planCombos(bills: Bill[], stances: Stance[], locales: Array<'en' | 'es'>): Combo[] {
  const combos: Combo[] = [];
  for (const bill of bills) {
    const slug = billSlug(bill);
    // Same formula app/api/script/route.ts uses — this IS the cache key's
    // content-version component, computed identically so a pregenerated
    // entry is a hit for the route's own lookup, never a permanent miss.
    const version = contentVersion(bill.ai_summary ?? bill.title);
    for (const stance of stances) {
      for (const lang of locales) {
        combos.push({ slug, stance, lang, version, bill });
      }
    }
  }
  return combos;
}

const ID_SEP = '--';
const STANCE_VALUES = new Set<Stance>(['support', 'oppose', 'undecided']);

/** Batch custom_id: self-describing, so result processing needs no bill lookup. */
export function customId(combo: Pick<Combo, 'slug' | 'stance' | 'lang' | 'version'>): string {
  return [combo.slug, combo.stance, combo.lang, combo.version].join(ID_SEP);
}

export interface ParsedCustomId {
  slug: string;
  stance: Stance;
  lang: 'en' | 'es';
  version: string;
}

export function parseCustomId(id: string): ParsedCustomId | null {
  const parts = id.split(ID_SEP);
  if (parts.length !== 4) return null;
  const [slug, stance, lang, version] = parts;
  if (!slug || !version) return null;
  if (!STANCE_VALUES.has(stance as Stance)) return null;
  if (lang !== 'en' && lang !== 'es') return null;
  return { slug, stance: stance as Stance, lang, version };
}

export interface BatchRequest {
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    thinking: { type: 'disabled' };
    messages: { role: 'user'; content: string }[];
  };
}

/** One Anthropic Message Batches API request row for a combo. */
export function buildBatchRequest(combo: Combo): BatchRequest {
  return {
    custom_id: customId(combo),
    params: {
      model: SCRIPT_MODEL,
      max_tokens: SCRIPT_MAX_TOKENS,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'user', content: buildScriptPrompt({ bill: combo.bill, stance: combo.stance, lang: combo.lang }) },
      ],
    },
  };
}

/*
 * Cost model — grounded in strategy §9.1(d)'s own figures (max_tokens 520,
 * ~200 realistic output tokens, Sonnet 5): $0.0028/gen at intro pricing
 * ($2/$10 per M tok, through Aug 31 2026), $0.0042/gen at standard pricing
 * ($3/$15 per M tok, Sept 1 on). These are the doc's numbers, not rederived
 * here — keep them in sync with the strategy doc if pricing changes.
 */
export const COST_PER_GEN_NON_BATCH = { intro: 0.0028, standard: 0.0042 };
export const BATCH_DISCOUNT = 0.5;
const NIGHTS_PER_MONTH = 30;

export interface CostEstimate {
  generations: number;
  perNightBatch: { intro: number; standard: number };
  perNightSyncFallback: { intro: number; standard: number };
  perMonthBatch: { intro: number; standard: number };
  perMonthSyncFallback: { intro: number; standard: number };
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Dollar estimate for pregenerating `generations` scripts tonight. */
export function estimateCost(generations: number): CostEstimate {
  const perNightSyncFallback = {
    intro: round(generations * COST_PER_GEN_NON_BATCH.intro),
    standard: round(generations * COST_PER_GEN_NON_BATCH.standard),
  };
  const perNightBatch = {
    intro: round(perNightSyncFallback.intro * BATCH_DISCOUNT),
    standard: round(perNightSyncFallback.standard * BATCH_DISCOUNT),
  };
  return {
    generations,
    perNightBatch,
    perNightSyncFallback,
    perMonthBatch: {
      intro: round(perNightBatch.intro * NIGHTS_PER_MONTH),
      standard: round(perNightBatch.standard * NIGHTS_PER_MONTH),
    },
    perMonthSyncFallback: {
      intro: round(perNightSyncFallback.intro * NIGHTS_PER_MONTH),
      standard: round(perNightSyncFallback.standard * NIGHTS_PER_MONTH),
    },
  };
}

export interface BatchResultRow {
  custom_id: string;
  result:
    | { type: 'succeeded'; message: { content: Array<{ type: string; text?: string }> } }
    | { type: 'errored'; error?: unknown }
    | { type: 'canceled' }
    | { type: 'expired' };
}

export interface ExtractedScript {
  ok: boolean;
  script: string | null;
  reason: string | null;
}

/** Pull the generated script text out of one batch result row, or say why not. */
export function extractScriptFromResult(row: BatchResultRow): ExtractedScript {
  if (row.result.type !== 'succeeded') {
    return { ok: false, script: null, reason: row.result.type };
  }
  const block = row.result.message.content.find((c) => c.type === 'text');
  const text = block && typeof block.text === 'string' ? block.text.trim() : '';
  if (!text) return { ok: false, script: null, reason: 'empty' };
  return { ok: true, script: text, reason: null };
}
