/**
 * One-off: regenerate bill headlines in EN + ES with varied constructions.
 * The original corpus used one "Topic — Consequence" template for all 480,
 * which reads machine-written at feed scale. Writes data/headlines-v2.json
 * as { [slug]: { en, es } }; merge with scripts/merge-headlines.mjs.
 * Resume-safe. Run: node --env-file=.env.local scripts/regenerate-headlines.mjs
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const anthropic = new Anthropic({ maxRetries: 8 });
const OUT = 'data/headlines-v2.json';
const CONCURRENCY = 6;

const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
const done = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const slug = (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
const todo = bills.filter((b) => b.ai_summary && !done[slug(b)]);
console.log(`${todo.length} headlines to regenerate (${Object.keys(done).length} done)`);

const clean = (s) =>
  s.trim().replace(/^["“']|["”']$/g, '').split('\n')[0].slice(0, 110);

async function regen(b) {
  const prompt = `Write one headline for this congressional bill, in English and in Spanish.

Bill: ${b.bill_type.toUpperCase()} ${b.bill_number}
Plain-language summary:
${b.ai_summary.slice(0, 1200)}

Rules:
- Like a careful, neutral news desk: factual, specific (name the agency, rule, or program), scannable.
- 45-90 characters. Sentence case.
- VARY the construction: do NOT use the "Topic — Consequence" em-dash template, and avoid colons as a crutch. A plain declarative sentence or a strong noun phrase both work.
- Strictly nonpartisan. No alarm words, no spin, no "Congress" as the first word.
- The Spanish headline is a natural headline in its own right, not a word-for-word translation.

Output exactly two lines, nothing else:
line 1: the English headline
line 2: the Spanish headline`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('bad shape');
  const enH = clean(lines[0]);
  const esH = clean(lines[1]);
  if (enH.length < 20 || esH.length < 20 || /^congress/i.test(enH)) throw new Error('rejected');
  return { en: enH, es: esH };
}

let completed = 0;
let failed = 0;
async function worker(q) {
  for (;;) {
    const b = q.shift();
    if (!b) return;
    try {
      done[slug(b)] = await regen(b);
      completed++;
      if (completed % 25 === 0) {
        writeFileSync(OUT, JSON.stringify(done));
        console.log(`${completed}/${todo.length}`);
      }
    } catch (e) {
      failed++;
      console.error(`FAIL ${slug(b)}: ${e.message}`);
    }
  }
}
const q = [...todo];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(q)));
writeFileSync(OUT, JSON.stringify(done));
console.log(`DONE: ${completed} regenerated, ${failed} failed, total ${Object.keys(done).length}`);
