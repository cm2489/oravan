/**
 * One-time (resumable) backfill of press_names / news_query for bills decoded
 * before search-input generation existed. Skips bills that already have the
 * fields, so re-runs are cheap and it can drain in budgeted slices.
 *
 *   node --env-file=.env.local scripts/backfill-search-inputs.mjs
 *
 * Env:
 *   BACKFILL_LIMIT  max bills to process this run (default: all remaining)
 *   BACKFILL_SLUGS  path to a newline-separated slug list to restrict to
 *                   (used by the eval harness to prepare its sample only)
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { generateSearchInputs } from './search-inputs.mjs';

const LIMIT = Number(process.env.BACKFILL_LIMIT ?? Infinity);
const SLUGS_FILE = process.env.BACKFILL_SLUGS;

const anthropic = new Anthropic({ maxRetries: 8 });
const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));

const only = SLUGS_FILE
  ? new Set(readFileSync(SLUGS_FILE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean))
  : null;

const slugOf = (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();

const todo = bills.filter((b) =>
  b.ai_headline &&
  b.press_names === undefined && b.news_query === undefined &&
  (!only || only.has(slugOf(b)))
);

console.log(`backfill: ${todo.length} bills need search inputs${only ? ` (restricted to ${only.size} slugs)` : ''}, processing up to ${LIMIT}`);

let done = 0;
for (const b of todo) {
  if (done >= LIMIT) break;
  try {
    const { press_names, news_query } = await generateSearchInputs(anthropic, b);
    b.press_names = press_names;
    b.news_query = news_query;
    done++;
    if (done % 50 === 0) {
      writeFileSync('data/bills.json', JSON.stringify(bills));
      console.log(`  checkpoint: ${done}/${Math.min(LIMIT, todo.length)}`);
    }
  } catch (e) {
    console.error(`FAIL ${slugOf(b)}: ${e.message}`);
  }
}

writeFileSync('data/bills.json', JSON.stringify(bills));
console.log(`DONE: ${done} bills backfilled, ${todo.length - done} remaining`);
