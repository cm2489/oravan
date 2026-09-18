/**
 * Does the Spanish half of a decode need Sonnet 5?
 *
 * WHY THIS EXISTS. Measured 2026-09-18 over the committed corpus, the Spanish
 * output is the single biggest line in a decode's bill: call 2 emits the full
 * ES summary plus the four ES sections and the ES headline, roughly 950 of its
 * ~1,600 output tokens, at $10 per million. Moving that half to Haiku 4.5 ($5
 * per million out) is the largest single lever left in the pipeline — and it
 * is also the one lever that can quietly make the product worse, because
 * bilingual parity is a hard rule and a Spanish reader is the only person who
 * would notice a thinner translation.
 *
 * So this script does NOT flip anything. It produces the evidence a human
 * needs to decide: for N recently-decoded bills it asks Haiku 4.5 and Sonnet 5
 * for the SAME Spanish translation of the SAME already-written English decode,
 * and writes them side by side for a reader who can judge Spanish. Nothing it
 * writes touches data/; the output is a scratch markdown file.
 *
 * USAGE
 *   node --env-file=.env.local scripts/eval-translation.mjs [--n 10] [--out PATH]
 *
 * COST. Two calls per bill. Per bill the input is one English decode
 * (~2,900 characters, ~950 tokens) and the output is its Spanish twin
 * (~2,700 characters, ~950 tokens). At list prices that is
 *   Sonnet 5:  950/1e6*$2  + 950/1e6*$10 = $0.0114
 *   Haiku 4.5: 950/1e6*$1  + 950/1e6*$5  = $0.0057
 * = $0.0171 a bill, so the default N=10 run costs about $0.17, and $0.30
 * covers N=17. It refuses to start without ANTHROPIC_API_KEY and prints the
 * estimate before spending anything.
 *
 * WHAT IT IS NOT. It is not a grader. There is no automated score here on
 * purpose: the question ("is this Spanish as good?") is exactly the kind a
 * model should not be trusted to answer about its own cheaper sibling, and a
 * number would give the decision a confidence it has not earned. The
 * deliverable is a document a person reads.
 */
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'node:fs';
import { loadJSON } from './bill-decode.mjs';

export const CANDIDATE_MODEL = 'claude-haiku-4-5-20251001';
export const INCUMBENT_MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 2000;

/** Per-million list prices, input/output, for the run's cost estimate only. */
const PRICES = {
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'claude-sonnet-5': { in: 2, out: 10 },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

/**
 * The translation half of the decode prompt, lifted verbatim in substance
 * from scripts/bill-decode.mjs's call 2 so the comparison measures the model
 * and not a different instruction. Kept as its own function rather than
 * imported because call 2 does five other things at the same time; this asks
 * only for the Spanish.
 */
export function buildTranslationPrompt(bill) {
  const s = bill.ai_sections ?? {};
  return `Translate this English plain-language explanation of a US congressional bill into Spanish.

Bill: ${bill.bill_type.toUpperCase()} ${bill.bill_number}

[HEADLINE]
${bill.ai_headline ?? ''}
[TLDR]
${s.tldr ?? ''}
[WHAT]
${s.what ?? ''}
[WHO]
${s.who ?? ''}
[WHY]
${s.why ?? ''}
[COST]
${s.cost ?? 'NONE'}
[SUMMARY]
${bill.ai_summary ?? ''}

RULES:
- Natural Latin American Spanish, 8th-grade reading level.
- Citations and numbers exact. Agency names in English with a short gloss when helpful.
- Strictly nonpartisan: no advocacy, no benefits-framing, no wording that leans for or against the bill.
- Translate only. Add nothing the English does not say, and drop nothing it does.
- Plain text, no markdown.

Output exactly the same tags, each on its own line followed by its content:
[HEADLINE]
[TLDR]
[WHAT]
[WHO]
[WHY]
[COST]
[SUMMARY]`;
}

/** The N most recently decoded bills that have a full English decode to
 *  translate. Recent, because a stale decode is not what production would be
 *  asking either model to handle tonight. */
export function pickBills(bills, n) {
  return bills
    .filter((b) => b.ai_summary && b.ai_headline && b.ai_sections?.tldr && b.decoded_at)
    .sort((a, b) => String(b.decoded_at).localeCompare(String(a.decoded_at)))
    .slice(0, n);
}

/** Dollar estimate for one run, from the prices above and measured sizes. */
export function estimateCost(n, { inputTokens = 950, outputTokens = 950 } = {}) {
  let total = 0;
  for (const model of [CANDIDATE_MODEL, INCUMBENT_MODEL]) {
    const p = PRICES[model];
    total += n * ((inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out);
  }
  return Math.round(total * 10_000) / 10_000;
}

export function renderMarkdown(rows, { n }) {
  const lines = [
    '# Spanish translation: Haiku 4.5 vs Sonnet 5',
    '',
    `${n} recently decoded bills. Both columns translate the SAME English decode with the SAME prompt; the only variable is the model.`,
    '',
    `- Candidate (cheaper): \`${CANDIDATE_MODEL}\``,
    `- Incumbent (shipping today): \`${INCUMBENT_MODEL}\``,
    '',
    'Read for: numbers and citations kept exact, agency names handled, register at an 8th-grade level, and — the one that matters most — nothing that reads as advocacy in either direction. A single failure on any of those is a reason not to switch.',
    '',
  ];
  for (const row of rows) {
    lines.push(`## ${row.slug} — ${row.title}`, '');
    lines.push('### English (shipping decode)', '', '```', row.english, '```', '');
    lines.push(`### ${CANDIDATE_MODEL}`, '', '```', row.candidate ?? `(failed: ${row.candidateError})`, '```', '');
    lines.push(`### ${INCUMBENT_MODEL}`, '', '```', row.incumbent ?? `(failed: ${row.incumbentError})`, '```', '');
  }
  return lines.join('\n');
}

async function translate(anthropic, model, bill) {
  const msg = await anthropic.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: buildTranslationPrompt(bill) }],
  });
  return msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '';
}

if (/(^|\/)eval-translation\.mjs$/.test(process.argv[1] ?? '')) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('eval-translation: ANTHROPIC_API_KEY is not set. This script spends money and will not guess at a key; run it with --env-file=.env.local or export the key.');
    process.exit(1);
  }
  const n = Number(arg('n', 10));
  const out = arg('out', 'eval-translation.md');
  const bills = pickBills(loadJSON('data/bills.json'), n);
  console.log(`eval-translation: ${bills.length} bill(s), 2 calls each, estimated cost $${estimateCost(bills.length)} at list prices.`);

  const anthropic = new Anthropic({ maxRetries: 4 });
  const rows = [];
  for (const bill of bills) {
    const slug = bill.full_identifier;
    const s = bill.ai_sections ?? {};
    const english = [bill.ai_headline, s.tldr, s.what, s.who, s.why, s.cost, bill.ai_summary]
      .filter(Boolean).join('\n\n');
    const row = { slug, title: bill.title, english, candidate: null, incumbent: null };
    for (const [key, model] of [['candidate', CANDIDATE_MODEL], ['incumbent', INCUMBENT_MODEL]]) {
      try {
        row[key] = await translate(anthropic, model, bill);
      } catch (e) {
        row[`${key}Error`] = e.message;
        console.error(`  ${slug} ${model}: ${e.message}`);
      }
    }
    rows.push(row);
    console.log(`  ${slug}: done`);
  }
  writeFileSync(out, renderMarkdown(rows, { n: rows.length }));
  console.log(`eval-translation: wrote ${out}. Read it before changing any model id.`);
}
