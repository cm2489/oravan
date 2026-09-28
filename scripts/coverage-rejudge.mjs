/**
 * Big Questions coverage re-judge: a DRY RUN that lists and never deletes.
 *
 * Step 1 of 2 of the Big-Questions-only coverage cleanup. The owner, on
 * 2026-09-28, about coverage: "For now lets just do covereage on the Big
 * Questions so I can monitor how it's doing from a user perspective and then
 * we can add it site wide."
 *
 * For every bill vehicle of a LIVE Big Question (data/moments.json), it sends
 * ONE request to the model the nightly relevance gate uses (MODEL below, the
 * same as scripts/sync-coverage.mjs), showing every article stored for that
 * bill in data/coverage.json and asking, per article, one of:
 *   this      about this bill or its subject
 *   other     about a different measure (named when the article names it)
 *   unrelated about neither
 * The first two overlap (a sibling resolution is often on the same subject),
 * so the prompt says which wins: an article mainly about one specific
 * different measure is "other". Finding those is what this cleanup is for.
 * It writes a report (report.md + report.json) to --out and NOTHING else:
 * nothing in data/ is written, nothing is deleted, nothing is committed.
 * Acting on the verdicts is step 2, a separate change the owner decides on.
 *
 *   node scripts/coverage-rejudge.mjs --plan    # no key, no request: what would be sent and its cost
 *   node scripts/coverage-rejudge.mjs --out coverage-rejudge-report
 *
 * Run by .github/workflows/coverage-rejudge.yml (workflow_dispatch only).
 *
 * Spend guards, all in code:
 *   - at most one request per vehicle bill (`requestCap`), counted as sent;
 *     the SDK may retry a request that failed (408, 409, 429, a 5xx, or a
 *     dropped connection) up to twice, and those retries are not counted
 *     separately;
 *   - a bill with no stored articles sends nothing;
 *   - the run refuses to start when the estimate is over COST_CEILING_USD;
 *   - no client is built unless ANTHROPIC_API_KEY is set in the environment,
 *     so a machine without that variable sends nothing even if it holds some
 *     other Anthropic credential.
 *
 * No `import.meta` and no top-level await: tests/coverage-rejudge.unit.spec.ts
 * imports this file through Playwright's transform (see the same note in
 * scripts/check-client-imports.mjs).
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { vehicleKind } from '../lib/moments-gate.mjs';
import { MODEL_PRICE_PER_MTOK } from '../lib/pipeline-health.mjs';
import { coverageSlug, pressCitation } from './coverage-query.mjs';

/** The nightly relevance gate's model (scripts/sync-coverage.mjs `MODEL`). A test keeps the two equal. */
export const MODEL = 'claude-haiku-4-5-20251001';

/** Its list price per million tokens, from the repo's one price table. */
export const PRICE = MODEL_PRICE_PER_MTOK['claude-haiku-4-5'];

/**
 * The run refuses to start above this estimate. A dry run over today's live
 * vehicles costs cents; $3 is the ceiling scripts/eval-translation.mjs uses for
 * an unattended run, so a much larger set of vehicles stops and asks first.
 */
export const COST_CEILING_USD = 3;

/**
 * Characters per input token for the estimate made BEFORE anything is sent.
 * An assumption, not a tokenizer count. English usually runs nearer 4, so 3
 * makes the estimate read high on purpose.
 */
export const CHARS_PER_TOKEN = 3;

export const DEFAULT_OUT = 'coverage-rejudge-report';

export const VERDICT_LABELS = Object.freeze({
  this: 'About this bill or its subject',
  other: 'About a different measure',
  unrelated: 'Unrelated',
});
export const NO_VERDICT_LABEL = 'No verdict';

const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** Output room per request: a short line per article, plus slack for a named measure. */
export const maxTokensFor = (n) => 40 + 40 * n;

/** Dollars at list price. */
export function costUsd(inputTokens, outputTokens, price = PRICE) {
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/**
 * The live Big Questions and their bill vehicles, in file order. A retired
 * question and a nomination vehicle are left out; a slug is listed once per
 * question.
 *
 * @param {any} moments data/moments.json
 * @returns {{ id: string, name: string, slugs: string[] }[]}
 */
export function liveVehicleBills(moments) {
  const questions = [];
  for (const [id, m] of Object.entries(moments ?? {})) {
    if (id.startsWith('_') || m?.status !== 'live') continue;
    const slugs = [];
    for (const v of m.vehicles ?? []) {
      const slug = v?.slug ? String(v.slug).toLowerCase() : null;
      if (slug && vehicleKind(v) === 'bill' && !slugs.includes(slug)) slugs.push(slug);
    }
    questions.push({ id, name: oneLine(m.name?.en) || id, slugs });
  }
  return questions;
}

/**
 * The one question asked per bill. The same bill facts the nightly gate's
 * relevancePrompt shows (scripts/coverage-query.mjs: headline, what it does,
 * introduced and latest-action dates, each article's date), with the citation
 * in press style and a three-way verdict per article instead of a keep list.
 *
 * @param {any} b the bill (data/bills.json)
 * @param {{title?: string, snippet?: string|null, source?: string, publishedAt?: string|null}[]} articles
 */
export function rejudgePrompt(b, articles) {
  const list = articles
    .map(
      (a, i) =>
        `${i}. [${isDay(a?.publishedAt) ? a.publishedAt : 'undated'}] ${oneLine(a?.title)}` +
        `${a?.snippet ? ` — ${oneLine(a.snippet)}` : ''} (${a?.source ?? 'unknown outlet'})`,
    )
    .join('\n');
  const action = oneLine(b.last_action_text).slice(0, 200);
  return `A US congressional bill:
${pressCitation(b)} — ${b.ai_headline ?? b.title}
What it does: ${b.ai_sections?.tldr ?? b.ai_summary ?? b.title}
Introduced: ${isDay(b.introduced_date) ? b.introduced_date : 'unknown'}. Latest action (${isDay(b.last_action_date) ? b.last_action_date : 'undated'}): ${action || 'none recorded'}

Below are news articles currently stored as coverage of this bill, each with its publication date in brackets. Give each article exactly one verdict:
this = the article is about this bill or its subject
other = the article is about a different measure (another bill, resolution, executive order or rule)
unrelated = the article is about neither
When an article is mainly about one specific different measure, answer other, even if that measure is on the same subject as this bill.

Reply with one line per article, in order, and nothing else. Each line is one of:
<number>: this
<number>: other: <the other measure's name or number, or "unnamed">
<number>: unrelated

${list}`;
}

const VERDICT_LINE = /^(\d+)\s*[:.)]\s*(this|other|unrelated)\s*(?:$|[:\-–—]\s*(.*)$)/i;

function cleanMeasure(raw) {
  const s = oneLine(raw).replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!s || /^(unnamed|unknown|none|n\/a)$/i.test(s)) return null;
  return s.slice(0, 160);
}

/**
 * Read a reply into one verdict per article, or null where the reply gives
 * none. Conservative on purpose, because step 2 may act on these:
 *   - a reply that did not finish (stop_reason other than "end_turn") gives
 *     no verdict at all;
 *   - a line must be exactly "<n>: this", "<n>: other[: name]" or
 *     "<n>: unrelated" (":", "." or ")" after the number; a dash or colon
 *     before any trailing words), so "0: this is not about the bill" is
 *     unreadable, not "this";
 *   - an article with two lines, or none, has no verdict;
 *   - every problem is listed, and `complete` is true only when there are none.
 *
 * @param {string|null|undefined} text
 * @param {number} n articles shown
 * @param {{ stopReason?: string|null }} [meta]
 * @returns {{ verdicts: ({verdict: 'this'|'other'|'unrelated', measure: string|null}|null)[], complete: boolean, problems: string[] }}
 */
export function parseVerdicts(text, n, { stopReason } = {}) {
  /** @type {({verdict: 'this'|'other'|'unrelated', measure: string|null}|null)[]} */
  const verdicts = Array.from({ length: n }, () => null);
  const problems = [];
  if (stopReason !== 'end_turn') {
    problems.push(`the reply did not finish (stop_reason: ${stopReason ?? 'missing'}), so no verdict is read from it`);
    return { verdicts, complete: false, problems };
  }
  const seen = new Set();
  const doubled = new Set();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(VERDICT_LINE);
    if (!m) {
      problems.push(`unreadable line: "${line.slice(0, 100)}"`);
      continue;
    }
    const i = Number(m[1]);
    if ((m[1].length > 1 && m[1].startsWith('0')) || !Number.isSafeInteger(i) || i >= n) {
      problems.push(`a line for article ${m[1]}, but articles 0-${n - 1} were shown`);
      continue;
    }
    if (seen.has(i)) {
      doubled.add(i);
      continue;
    }
    seen.add(i);
    const verdict = /** @type {'this'|'other'|'unrelated'} */ (m[2].toLowerCase());
    verdicts[i] = { verdict, measure: verdict === 'other' ? cleanMeasure(m[3]) : null };
  }
  for (const i of doubled) {
    verdicts[i] = null;
    problems.push(`article ${i} got more than one line, so it has no verdict`);
  }
  for (let i = 0; i < n; i++) {
    if (!seen.has(i)) problems.push(`article ${i} got no line`);
  }
  return { verdicts, complete: problems.length === 0, problems };
}

/**
 * What would be sent, and its estimated cost. Pure: reads the three parsed
 * files, calls nothing.
 *
 * @param {{ moments: any, coverage: any, bills: any[] }} input
 */
export function planRejudge({ moments, coverage, bills }) {
  const questions = liveVehicleBills(moments);
  const billBySlug = new Map((bills ?? []).map((b) => [coverageSlug(b), b]));
  /** @type {Map<string, {slug: string, citation: string, questions: string[], articles: any[], skip: string|null, prompt: string|null, maxTokens: number}>} */
  const items = new Map();
  for (const q of questions) {
    for (const slug of q.slugs) {
      const known = items.get(slug);
      if (known) {
        known.questions.push(q.id);
        continue;
      }
      const bill = billBySlug.get(slug) ?? null;
      const articles = Array.isArray(coverage?.[slug]) ? coverage[slug] : [];
      const skip = !bill ? 'not in data/bills.json, nothing sent' : articles.length === 0 ? 'no stored articles, nothing sent' : null;
      items.set(slug, {
        slug,
        citation: bill ? pressCitation(bill) : slug,
        questions: [q.id],
        articles,
        skip,
        prompt: skip ? null : rejudgePrompt(bill, articles),
        maxTokens: skip ? 0 : maxTokensFor(articles.length),
      });
    }
  }
  const all = [...items.values()];
  const toSend = all.filter((x) => !x.skip);
  const inputTokens = toSend.reduce((s, x) => s + Math.ceil((x.prompt ?? '').length / CHARS_PER_TOKEN), 0);
  const outputTokens = toSend.reduce((s, x) => s + x.maxTokens, 0);
  return {
    questions,
    bills: all,
    requestCap: all.length,
    requests: toSend.length,
    articles: all.reduce((s, x) => s + x.articles.length, 0),
    estimate: { inputTokens, outputTokens, usd: costUsd(inputTokens, outputTokens) },
  };
}

/**
 * Send the planned requests, one at a time, never more than `maxRequests`.
 *
 * @param {{ plan: ReturnType<typeof planRejudge>, client: any, maxRequests?: number, log?: (s: string) => void }} args
 */
export async function runRejudge({ plan, client, maxRequests = plan.requestCap, log = () => {} }) {
  // Never above one request per vehicle bill; a non-number falls back to that
  // (NaN would otherwise make `sent >= cap` always false, i.e. no cap).
  const cap = Number.isFinite(maxRequests) ? Math.max(0, Math.min(Math.floor(maxRequests), plan.requestCap)) : plan.requestCap;
  /** @type {Map<string, {verdicts: any[], problems: string[], error: string|null}>} */
  const results = new Map();
  let sent = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let stoppedAtCap = false;
  for (const item of plan.bills) {
    if (item.skip) continue;
    const none = item.articles.map(() => null);
    if (sent >= cap) {
      stoppedAtCap = true;
      results.set(item.slug, { verdicts: none, problems: [], error: `not sent: the ${cap}-request cap was reached` });
      continue;
    }
    sent++;
    try {
      const msg = await client.messages.create({
        model: MODEL,
        max_tokens: item.maxTokens,
        messages: [{ role: 'user', content: item.prompt }],
      });
      inputTokens += Number(msg?.usage?.input_tokens) || 0;
      outputTokens += Number(msg?.usage?.output_tokens) || 0;
      const text = (msg?.content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const parsed = parseVerdicts(text, item.articles.length, { stopReason: msg?.stop_reason });
      results.set(item.slug, { verdicts: parsed.verdicts, problems: parsed.problems, error: null });
      log(`${item.slug}: ${item.articles.length} article(s) judged${parsed.complete ? '' : ` (${parsed.problems.length} reply problem(s))`}`);
    } catch (e) {
      const why = oneLine(e instanceof Error ? e.message : e).slice(0, 200);
      results.set(item.slug, { verdicts: none, problems: [], error: `request failed: ${why}` });
      log(`${item.slug}: request failed: ${why}`);
    }
  }
  return { results, sent, cap, stoppedAtCap, usage: { inputTokens, outputTokens, usd: costUsd(inputTokens, outputTokens) } };
}

const round4 = (n) => Math.round(n * 10_000) / 10_000;

/**
 * The report object (report.json). Totals count each bill once, even when it
 * is a vehicle of two questions.
 *
 * @param {{ plan: ReturnType<typeof planRejudge>, run: Awaited<ReturnType<typeof runRejudge>>, now?: Date }} args
 */
export function buildReport({ plan, run, now = new Date() }) {
  const totals = { questions: plan.questions.length, bills: plan.bills.length, articles: 0, this: 0, other: 0, unrelated: 0, noVerdict: 0 };
  const bills = plan.bills.map((item) => {
    const r = run.results.get(item.slug);
    const articles = item.articles.map((a, index) => {
      const v = r?.verdicts?.[index] ?? null;
      if (!item.skip) {
        totals.articles++;
        if (v) totals[v.verdict]++;
        else totals.noVerdict++;
      }
      return {
        index,
        title: a?.title ?? null,
        url: a?.url ?? null,
        source: a?.source ?? null,
        publishedAt: a?.publishedAt ?? null,
        verdict: v?.verdict ?? null,
        measure: v?.measure ?? null,
      };
    });
    return {
      slug: item.slug,
      citation: item.citation,
      questions: item.questions,
      skipped: item.skip,
      error: r?.error ?? null,
      problems: r?.problems ?? [],
      articles,
    };
  });
  return {
    kind: 'coverage-rejudge',
    dryRun: true,
    note: 'Lists only. Nothing in data/ was changed, nothing was deleted, nothing was committed.',
    aiLabel: `Every verdict here was written by AI (${MODEL}). No person reviewed them.`,
    generatedAt: now.toISOString(),
    model: MODEL,
    requests: { sent: run.sent, cap: run.cap, stoppedAtCap: run.stoppedAtCap },
    cost: {
      estimateUsd: round4(plan.estimate.usd),
      actualUsd: round4(run.usage.usd),
      inputTokens: run.usage.inputTokens,
      outputTokens: run.usage.outputTokens,
      pricePerMTok: PRICE,
      estimateAssumption: `input at ${CHARS_PER_TOKEN} characters per token, output at each request's max_tokens`,
    },
    totals,
    questions: plan.questions.map((q) => ({ id: q.id, name: q.name, bills: q.slugs })),
    bills,
  };
}

const cell = (v) => oneLine(v).replace(/\|/g, '\\|');
const usd = (n) => `$${n.toFixed(4)}`;

function verdictText(a) {
  if (!a.verdict) return NO_VERDICT_LABEL;
  if (a.verdict === 'other') return `${VERDICT_LABELS.other}: ${a.measure ? cell(a.measure) : '(not named)'}`;
  return VERDICT_LABELS[a.verdict];
}

function billCounts(bill) {
  const c = { this: 0, other: 0, unrelated: 0, none: 0 };
  for (const a of bill.articles) c[a.verdict ?? 'none']++;
  return [
    c.this && `${c.this} about this bill or its subject`,
    c.other && `${c.other} about a different measure`,
    c.unrelated && `${c.unrelated} unrelated`,
    c.none && `${c.none} with no verdict`,
  ]
    .filter(Boolean)
    .join(', ');
}

/** report.md: totals first, then each live question and its bills. */
export function renderMarkdown(report) {
  const t = report.totals;
  const out = [
    '# Big Questions coverage re-judge (dry run)',
    '',
    `**${report.note}**`,
    '',
    `${report.aiLabel} Run ${report.generatedAt}.`,
    '',
    `Requests sent: ${report.requests.sent} of a cap of ${report.requests.cap}${report.requests.stoppedAtCap ? ' (the cap stopped the run)' : ''}. ` +
      `Cost at list price ($${report.cost.pricePerMTok.input}/$${report.cost.pricePerMTok.output} per million tokens in/out): ` +
      `${usd(report.cost.actualUsd)} from the API's own token counts (${report.cost.inputTokens} in, ${report.cost.outputTokens} out); ` +
      `the estimate before sending was ${usd(report.cost.estimateUsd)}.`,
    '',
    '## Totals',
    '',
    `${t.questions} live question(s), ${t.bills} vehicle bill(s), ${t.articles} stored article(s) judged.`,
    '',
    '| Verdict | Articles |',
    '|---|---|',
    `| ${VERDICT_LABELS.this} | ${t.this} |`,
    `| ${VERDICT_LABELS.other} | ${t.other} |`,
    `| ${VERDICT_LABELS.unrelated} | ${t.unrelated} |`,
    `| ${NO_VERDICT_LABEL} | ${t.noVerdict} |`,
    '',
  ];
  const bySlug = new Map(report.bills.map((b) => [b.slug, b]));
  for (const q of report.questions) {
    out.push(`## ${cell(q.name)}`, '');
    if (!q.bills.length) out.push('No bill vehicles.', '');
    for (const slug of q.bills) {
      const b = bySlug.get(slug);
      if (!b) continue;
      const head = `### ${cell(b.citation)} (${b.slug})`;
      if (b.skipped) {
        out.push(head, '', `${b.skipped[0].toUpperCase()}${b.skipped.slice(1)}.`, '');
        continue;
      }
      out.push(head, '', `${b.articles.length} stored: ${billCounts(b)}.`, '');
      if (b.error) out.push(`**${cell(b.error)}**`, '');
      out.push('| # | Verdict | Article | Outlet | Published |', '|---|---|---|---|---|');
      for (const a of b.articles) {
        const title = cell(a.title) || '(untitled)';
        const link = a.url ? `[${title.replace(/[[\]]/g, '')}](${String(a.url).replace(/\)/g, '%29').replace(/\s/g, '%20')})` : title;
        out.push(`| ${a.index} | ${verdictText(a)} | ${link} | ${cell(a.source)} | ${cell(a.publishedAt) || 'undated'} |`);
      }
      out.push('');
      if (b.problems.length) {
        out.push('Reply problems (the articles they touch have no verdict):', '');
        for (const p of b.problems) out.push(`- ${cell(p)}`);
        out.push('');
      }
    }
  }
  return `${out.join('\n')}\n`;
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1] ?? null;
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
}

/** True when `dir` is data/ or anything under it. */
export function isInsideData(dir, root) {
  const rel = relative(resolve(root, 'data'), resolve(root, dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The script. Returns the exit code instead of exiting, so the no-write test
 * can run it against a temporary copy of data/ with a mocked client.
 *
 * @param {string[]} [argv]
 * @param {{ env?: Record<string, string|undefined>, root?: string, client?: any, log?: (s: string) => void, now?: Date }} [opts]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), { env = process.env, root = process.cwd(), client = null, log = console.log, now = new Date() } = {}) {
  const outArg = argValue(argv, '--out') ?? DEFAULT_OUT;
  if (isInsideData(outArg, root)) {
    log(`coverage-rejudge: REFUSING --out ${outArg}: the report never goes in data/.`);
    return 2;
  }
  const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
  const plan = planRejudge({ moments: read('data/moments.json'), coverage: read('data/coverage.json'), bills: read('data/bills.json') });
  log(
    `PLAN: ${plan.questions.length} live question(s), ${plan.requestCap} vehicle bill(s), ${plan.articles} stored article(s); ` +
      `${plan.requests} request(s) to send (one per bill with stored articles), hard cap ${plan.requestCap}`,
  );
  for (const x of plan.bills) log(`  ${x.slug}: ${x.skip ?? `${x.articles.length} article(s)`}`);
  log(
    `ESTIMATE: ${usd(plan.estimate.usd)} at list price for ${MODEL} ($${PRICE.input}/$${PRICE.output} per million tokens in/out): ` +
      `~${plan.estimate.inputTokens} input tokens (${CHARS_PER_TOKEN} characters per token, assumed) + at most ${plan.estimate.outputTokens} output tokens`,
  );
  if (argv.includes('--plan')) {
    log('--plan: nothing sent, nothing written.');
    return 0;
  }
  if (plan.estimate.usd > COST_CEILING_USD) {
    log(`coverage-rejudge: REFUSING to start: the estimate is over the $${COST_CEILING_USD.toFixed(2)} ceiling. Nothing sent.`);
    return 2;
  }
  let api = client;
  if (!api) {
    if (!env.ANTHROPIC_API_KEY) {
      log('coverage-rejudge: ANTHROPIC_API_KEY is not set. Nothing sent, nothing written. (Use --plan to see what would be sent.)');
      return 1;
    }
    api = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
  }
  const run = await runRejudge({ plan, client: api, log });
  const report = buildReport({ plan, run, now });
  const outDir = resolve(root, outArg);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, 'report.md'), renderMarkdown(report));
  const t = report.totals;
  log(
    `SUMMARY: ${t.articles} stored article(s) on ${t.bills} vehicle bill(s) of ${t.questions} live question(s): ` +
      `${t.this} about this bill or its subject, ${t.other} about a different measure, ${t.unrelated} unrelated, ${t.noVerdict} no verdict. ` +
      `${run.sent} request(s) sent of a cap of ${run.cap}${run.stoppedAtCap ? ' (the cap stopped the run)' : ''}; ` +
      `cost ${usd(run.usage.usd)} (estimate ${usd(plan.estimate.usd)}). Report: ${relative(root, outDir) || '.'}/report.md. Nothing in data/ was written.`,
  );
  return 0;
}

if (/(^|[\\/])coverage-rejudge\.mjs$/.test(process.argv[1] ?? '')) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`coverage-rejudge: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    },
  );
}
