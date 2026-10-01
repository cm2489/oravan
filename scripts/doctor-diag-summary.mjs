// THROWAWAY diagnostic (branch doctor/diag-summary-20261001, never merged).
// Builds the penny question's real nightly plan from the committed data, then
// asks the real model for its "Where it stands" summary several times under
// each prompt variant, printing every raw reply and the lint verdict. Nothing
// is written. Spend is computed from usage at $2/$10 per MTok (Sonnet 5.5)
// and the run stops at DIAG_MAX_USD.
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { planSummaries, generateStateSummary } from './moment-updates.mjs';
import { lintRevisionText } from '../lib/moment-updates-gate.mjs';

const J = (p) => JSON.parse(readFileSync(p, 'utf8'));
const RUNS = Number(process.env.DIAG_RUNS ?? 6);
const MAX_USD = Number(process.env.DIAG_MAX_USD ?? 1.5);
const ID = process.env.DIAG_MOMENT ?? 'penny-production-and-cash-rounding';

const moments = J('data/moments.json');
const bills = J('data/bills.json');
const store = J('data/moment-updates.json');
const rollCalls = J('data/votes.json').rollCalls;
const plan = planSummaries({
  mode: 'nightly',
  moments: { [ID]: moments[ID] },
  store,
  billBySlug: new Map(bills.map((b) => [b.full_identifier, b])),
  rollCalls,
  floorSignals: J('data/floor-signals.json'),
  now: new Date(),
});
const p = plan[0];
console.log(`plan: ${ID} generate=${p.generate} reason=${p.reason} votes=${p.votes.length} onRecord=${JSON.stringify(p.rollCallsOnRecord)}`);
const contextRefs = (moments[ID].context_refs ?? []).map((r) => r?.url).filter(Boolean);

const real = new Anthropic();
let usd = 0;
const cost = (u) => ((u?.input_tokens ?? 0) * 2 + (u?.output_tokens ?? 0) * 10) / 1e6;

const OLD_LEN = '- 90 to 140 words per language. Plain text, no markdown, no headings.';
const NEW_LEN =
  '- Length follows the record: the record below is short, so the summary is short — 40 to 90 words per language, about one or two sentences for each vote or action. Never pad it with measures that did not move or with what did not happen. Plain text, no markdown, no headings.';

const VARIANTS = {
  baseline: (s) => s,
  shortRecord: (s) => {
    if (!s.includes(OLD_LEN)) throw new Error('length line not found');
    return s.replace(OLD_LEN, NEW_LEN);
  },
};

const groundedEvents = true;
const rollCallsOnRecord = Array.isArray(p.rollCallsOnRecord) ? p.rollCallsOnRecord.length : undefined;
const lint = (pair) => {
  const f = [];
  for (const lang of ['en', 'es']) {
    const v = String(pair?.[lang] ?? '').trim();
    if (!v) f.push(`${lang}: empty`);
    for (const x of lintRevisionText(v, lang, { groundedEvents, rollCallsOnRecord })) f.push(`${lang}: ${x}`);
  }
  return f;
};
const parse = (t) => {
  try {
    return JSON.parse(String(t).trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''));
  } catch {
    return null;
  }
};
const words = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean).length;

let printedPrompt = false;
const tally = {};
for (const [name, transform] of Object.entries(VARIANTS)) {
  tally[name] = { first: 0, firstPass: 0, retryPass: 0, retries: 0 };
  for (let i = 0; i < RUNS; i++) {
    if (usd >= MAX_USD) {
      console.log(`STOP: spend cap $${MAX_USD} reached`);
      break;
    }
    let req;
    let reply;
    const client = {
      messages: {
        create: async (r) => {
          req = structuredClone(r);
          req.messages[0].content = transform(req.messages[0].content);
          const msg = await real.messages.create(req);
          usd += cost(msg.usage);
          reply = msg;
          return msg;
        },
      },
    };
    await generateStateSummary(client, ID, structuredClone(store[ID]), p.statuses, contextRefs, p.records, p.votes, p.rollCallsOnRecord);
    if (!printedPrompt) {
      console.log('===== BASELINE PROMPT =====\n' + req.messages[0].content + '\n===== END PROMPT =====');
      printedPrompt = true;
    }
    const text = reply?.content?.find((b) => b.type === 'text')?.text ?? '';
    const pair = parse(text);
    const fails = lint(pair);
    tally[name].first++;
    if (!fails.length) tally[name].firstPass++;
    console.log(`\n--- ${name} #${i + 1}: ${fails.length ? 'REJECTED' : 'PASS'} (en ${words(pair?.en)}w / es ${words(pair?.es)}w; stop ${reply?.stop_reason}; usage in ${reply?.usage?.input_tokens} out ${reply?.usage?.output_tokens})`);
    console.log(`EN: ${pair?.en}`);
    console.log(`ES: ${pair?.es}`);
    if (fails.length) console.log(`LINT: ${fails.join(' | ')}`);
    if (fails.length && usd < MAX_USD) {
      // One retry that names the rejection, in the same conversation.
      const retryReq = {
        ...req,
        messages: [
          req.messages[0],
          { role: 'assistant', content: reply.content },
          {
            role: 'user',
            content: `That summary was rejected automatically: ${fails.join('; ')}. Write it again from the same record, following every rule above. Leave out every sentence about what did not happen, did not move, was not recorded or is unchanged, in both languages. Output STRICT JSON only — {"en":"…","es":"…"} — no prose, no markdown fences, no other text.`,
          },
        ],
      };
      const m2 = await real.messages.create(retryReq);
      usd += cost(m2.usage);
      tally[name].retries++;
      const pair2 = parse(m2.content.find((b) => b.type === 'text')?.text ?? '');
      const f2 = lint(pair2);
      if (!f2.length) tally[name].retryPass++;
      console.log(`  RETRY: ${f2.length ? 'REJECTED' : 'PASS'} (en ${words(pair2?.en)}w / es ${words(pair2?.es)}w)`);
      console.log(`  EN: ${pair2?.en}`);
      console.log(`  ES: ${pair2?.es}`);
      if (f2.length) console.log(`  LINT: ${f2.join(' | ')}`);
    }
  }
}
console.log('\n===== TALLY =====');
console.log(JSON.stringify(tally, null, 1));
console.log(`spend: $${usd.toFixed(4)} (Sonnet 5.5 at $2/$10 per MTok, from usage)`);
