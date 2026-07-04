/**
 * One-off: turn each cost section into 2-3 short fact chips (EN+ES) for the
 * C-style decoded layout. Chips restate the cost text only - no new facts.
 * Prose cost is kept as the fallback. Resume-safe.
 *   node --env-file=.env.local scripts/generate-cost-chips.mjs
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';

const anthropic = new Anthropic({ maxRetries: 8 });
const MODEL = 'claude-sonnet-5';
const CONCURRENCY = 5;

const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
const es = JSON.parse(readFileSync('data/bills-es.json', 'utf8'));
const slugOf = (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();

const todo = bills.filter((b) => b.ai_sections?.cost && !b.ai_sections.costChips);
console.log(`${todo.length} cost sections to chip`);

function parseChips(line) {
  const chips = line.split('|').map((c) => c.trim()).filter(Boolean);
  if (chips.length < 1 || chips.length > 3 || chips.some((c) => c.length > 48)) {
    throw new Error(`bad chips: ${line.slice(0, 80)}`);
  }
  return chips;
}

async function chip(b) {
  const slug = slugOf(b);
  const esCost = es[slug]?.sections?.cost ?? '';
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 390,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: `Compress this bill-cost text into 2-3 short fact chips, in English and Spanish.

English cost text: ${b.ai_sections.cost}
Spanish cost text: ${esCost}

Rules:
- Each chip: a standalone fact fragment, max 45 characters, sentence case, no ending period.
- Use ONLY facts in the given text. Nonpartisan, neutral.
- Same number of chips in both languages, same order.

Output exactly two lines:
[EN] chip | chip | chip
[ES] chip | chip | chip` }],
  });
  const text = msg.content[0].text.trim();
  const enLine = text.match(/\[EN\](.*)/)?.[1];
  const esLine = text.match(/\[ES\](.*)/)?.[1];
  if (!enLine || !esLine) throw new Error('missing lines');
  const enChips = parseChips(enLine);
  const esChips = parseChips(esLine);
  if (enChips.length !== esChips.length) throw new Error('chip count mismatch');
  return { enChips, esChips };
}

let completed = 0;
let failed = 0;
function checkpoint() {
  writeFileSync('data/bills.json', JSON.stringify(bills));
  writeFileSync('data/bills-es.json', JSON.stringify(es));
}

async function worker(q) {
  for (;;) {
    const b = q.shift();
    if (!b) return;
    try {
      const r = await chip(b);
      b.ai_sections.costChips = r.enChips;
      const slug = slugOf(b);
      if (es[slug]?.sections) es[slug].sections.costChips = r.esChips;
      completed++;
      if (completed % 25 === 0) {
        checkpoint();
        console.log(`${completed}/${todo.length}`);
      }
    } catch (e) {
      failed++;
      console.error(`FAIL ${slugOf(b)}: ${e.message}`);
    }
  }
}

const q = [...todo];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(q)));
checkpoint();
console.log(`DONE: ${completed} chipped, ${failed} failed`);
