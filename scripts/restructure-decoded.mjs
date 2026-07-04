/**
 * One-off: restructure every decoded summary into A-plus sections
 * (tldr / what / who / why / cost?) in EN + ES, one API call per bill.
 * Sections are restatements of the existing summary - the prompt forbids
 * new facts, and the cost section exists only when the summary actually
 * contains cost/funding/penalty content.
 *
 * Writes ai_sections onto data/bills.json entries and sections onto
 * data/bills-es.json. ai_summary stays untouched (script-gen + fallback).
 * Resume-safe: skips bills that already have ai_sections.
 *
 *   node --env-file=.env.local scripts/restructure-decoded.mjs
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';

const anthropic = new Anthropic({ maxRetries: 8 });
const MODEL = 'claude-sonnet-5';
const CONCURRENCY = 5;

const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
const es = JSON.parse(readFileSync('data/bills-es.json', 'utf8'));
const slugOf = (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();

const todo = bills.filter((b) => b.ai_summary && !b.ai_sections);
console.log(`${todo.length} bills to restructure`);

const TAGS = ['TLDR', 'WHAT', 'WHO', 'WHY', 'COST', 'ES_TLDR', 'ES_WHAT', 'ES_WHO', 'ES_WHY', 'ES_COST'];

function parseTagged(text) {
  const out = {};
  for (let i = 0; i < TAGS.length; i++) {
    const tag = TAGS[i];
    const start = text.indexOf(`[${tag}]`);
    if (start === -1) throw new Error(`missing [${tag}]`);
    const next = TAGS.slice(i + 1)
      .map((t) => text.indexOf(`[${t}]`))
      .filter((x) => x > start);
    const end = next.length ? Math.min(...next) : text.length;
    out[tag] = text.slice(start + tag.length + 2, end).trim();
  }
  return out;
}

const norm = (s) => (s === 'NONE' || !s ? null : s);

async function restructure(b) {
  const prompt = `Restructure this plain-language bill summary into scannable sections, in English and Spanish.

Bill: ${b.bill_type.toUpperCase()} ${b.bill_number} — ${b.short_title ?? b.title}
Summary:
${b.ai_summary}

STRICT RULES:
- Use ONLY facts present in the summary above. Never add numbers, costs, or claims it doesn't contain.
- 8th-grade reading level, warm and plain, strictly nonpartisan. "Why" describes consequences, never benefits-framing or advocacy.
- TLDR: one sentence, max 160 characters, the single most decision-relevant fact.
- WHAT: 1-3 sentences. WHO: 1-2 sentences. WHY: 1-2 sentences of neutral consequence.
- COST: 1-2 sentences ONLY if the summary contains spending, funding, fines, or who-pays content; otherwise output exactly NONE.
- For a very thin summary, keep sections very short rather than padding.
- Spanish: natural Latin American Spanish, same rules; agency names in English with a gloss when helpful; output NONE for ES_COST exactly when COST is NONE.
- Plain text only, no markdown.

Output exactly this tagged format, each tag on its own line followed by the content:
[TLDR]
[WHAT]
[WHO]
[WHY]
[COST]
[ES_TLDR]
[ES_WHAT]
[ES_WHO]
[ES_WHY]
[ES_COST]`;

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1820,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: prompt }],
  });
  const t = parseTagged(msg.content[0].text);
  if (!t.TLDR || t.TLDR.length > 220 || !t.WHAT || !t.WHO || !t.WHY) throw new Error('bad shape');
  if ((norm(t.COST) === null) !== (norm(t.ES_COST) === null)) throw new Error('cost parity mismatch');
  return {
    en: { tldr: t.TLDR, what: t.WHAT, who: t.WHO, why: t.WHY, cost: norm(t.COST) },
    esS: { tldr: t.ES_TLDR, what: t.ES_WHAT, who: t.ES_WHO, why: t.ES_WHY, cost: norm(t.ES_COST) },
  };
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
      const r = await restructure(b);
      b.ai_sections = r.en;
      const slug = slugOf(b);
      es[slug] = { ...(es[slug] ?? {}), sections: r.esS };
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
console.log(`DONE: ${completed} restructured, ${failed} failed`);
