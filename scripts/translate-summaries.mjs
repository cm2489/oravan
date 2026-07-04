/**
 * One-off: translate decoded headlines + summaries to Spanish.
 * Writes data/bills-es.json as { [slug]: { headline, summary } }.
 * Resume-safe: skips slugs already present. Run:
 *   node --env-file=.env.local scripts/translate-summaries.mjs
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const anthropic = new Anthropic({ maxRetries: 8 });
const MODEL = 'claude-sonnet-5';
const OUT = 'data/bills-es.json';
const CONCURRENCY = 6;

const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
const done = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};

const slug = (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
const todo = bills.filter((b) => b.ai_summary && !done[slug(b)]);
console.log(`${todo.length} bills to translate (${Object.keys(done).length} already done)`);

let completed = 0;
let failed = 0;

async function translate(b) {
  const citation = `${b.bill_type.toUpperCase()} ${b.bill_number}`;
  const prompt = `Translate this plain-language explanation of US congressional bill ${citation} from English to Spanish.

Audience: Spanish-dominant US residents. Natural Latin American Spanish at an 8th-grade reading level, warm and plain, never bureaucratic.
Keep bill citations, numbers, and dates exactly as written. Keep US agency names in English, adding a short Spanish gloss in parentheses on first mention when it aids understanding.

HEADLINE (translate, keep the "Topic — Action" structure, max 90 characters):
${b.ai_headline ?? ''}

SUMMARY (translate fully, preserve paragraph breaks):
${b.ai_summary}

Return STRICT JSON only, no markdown fences: {"headline": "...", "summary": "..."}`;

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1950,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
  const cleaned = text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
  const parsed = JSON.parse(cleaned);
  if (!parsed.summary) throw new Error('empty summary');
  return { headline: parsed.headline ?? null, summary: parsed.summary };
}

async function worker(queue) {
  for (;;) {
    const b = queue.shift();
    if (!b) return;
    const s = slug(b);
    try {
      done[s] = await translate(b);
      completed++;
      if (completed % 20 === 0) {
        writeFileSync(OUT, JSON.stringify(done));
        console.log(`${completed}/${todo.length} (checkpoint saved)`);
      }
    } catch (e) {
      failed++;
      console.error(`FAIL ${s}: ${e.message}`);
    }
  }
}

const queue = [...todo];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
writeFileSync(OUT, JSON.stringify(done));
console.log(`DONE: ${completed} translated, ${failed} failed, total ${Object.keys(done).length}`);
