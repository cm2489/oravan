/**
 * A/B eval: old query builder vs new (scripts/coverage-query.mjs) on a
 * stratified sample of real bills, against the live TheNewsAPI.
 *
 *   node --env-file=.env.local scripts/eval-coverage-queries.mjs [--gate]
 *
 * Reads data/bills.json and data/coverage.json; writes NOTHING to data/.
 * Results go to stdout plus a JSON dump (path printed at the end).
 *
 * Cost model (deliberate): TheNewsAPI requests are plentiful (2/bill);
 * Anthropic spend is minimized — the Haiku relevance gate only runs with
 * --gate, only on arms that returned candidates, and reuses the EXACT prompt
 * from scripts/sync-coverage.mjs so kept-counts predict production.
 *
 * Sample strata:
 *   band     — the top-30 urgency band (what the site actually leads with)
 *   cra      — joint resolutions (unnamed, subject-covered)
 *   citonly  — House bills whose old query degraded to citation-only
 *   covered  — bills WITH coverage today (regression control: must not lose them)
 *   named    — named bills with no coverage today
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { TERMINAL_STATUSES, effectiveUrgency } from '../lib/urgency.mjs';
import { queryFor } from './coverage-query.mjs';

const NEWS_API_KEY = process.env.NEWS_API_KEY;
if (!NEWS_API_KEY) { console.error('NEWS_API_KEY required'); process.exit(1); }
const GATE = process.argv.includes('--gate');
const OUT = process.env.EVAL_OUT ?? '/tmp/coverage-eval.json';

const anthropic = new Anthropic({ maxRetries: 8 });
const MODEL = 'claude-haiku-4-5-20251001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
const coverage = JSON.parse(readFileSync('data/coverage.json', 'utf8'));
const slugOf = (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();

/* The query builder this PR replaces, verbatim, for the A arm. */
function oldQueryFor(b) {
  const ident = `${b.bill_type.toUpperCase()} ${b.bill_number}`;
  const name = (b.short_title ?? b.title ?? '').trim();
  const usableName = name && name.length <= 80 && !/^an act|^a bill|^to /i.test(name);
  return usableName ? `"${name}" | "${ident}"` : `"${ident}"`;
}

// ---- stratified, deterministic sample ----
const eligible = bills
  .filter((b) => b.ai_headline && !TERMINAL_STATUSES.has(b.status))
  .map((b) => ({ b, eff: effectiveUrgency(b.status, b.last_action_date) }))
  .sort((x, y) => y.eff - x.eff || (y.b.last_action_date ?? '').localeCompare(x.b.last_action_date ?? ''));

const strata = new Map(); // slug -> stratum (first assignment wins)
const assign = (list, name, n) => {
  let taken = 0;
  for (const { b } of list) {
    const s = slugOf(b);
    if (strata.has(s)) continue;
    strata.set(s, name);
    if (++taken >= n) break;
  }
};

assign(eligible, 'band', 30);
assign(eligible.filter(({ b }) => b.bill_type.endsWith('jres')), 'cra', 15);
assign(eligible.filter(({ b }) => oldQueryFor(b) === `"${b.bill_type.toUpperCase()} ${b.bill_number}"` && !b.bill_type.endsWith('jres')), 'citonly', 15);
assign(eligible.filter(({ b }) => coverage[slugOf(b)]?.length), 'covered', 15);
assign(eligible.filter(({ b }) => oldQueryFor(b).includes('|') && !coverage[slugOf(b)]), 'named', 15);

const sample = eligible.filter(({ b }) => strata.has(slugOf(b))).map(({ b }) => b);

if (process.argv.includes('--sample-only')) {
  // Emit the slug list (for BACKFILL_SLUGS) and exit without any API calls.
  console.log(sample.map(slugOf).join('\n'));
  process.exit(0);
}

console.log(`sample: ${sample.length} bills — ${JSON.stringify(Object.fromEntries([...new Set(strata.values())].map((s) => [s, [...strata.values()].filter((v) => v === s).length])))}`);
console.log(`gate: ${GATE ? 'ON (Haiku, candidates-only)' : 'OFF (candidates comparison only — rerun with --gate for kept-counts)'}\n`);

// ---- TheNewsAPI fetch (mirrors sync-coverage's adapter + throttle) ----
let rlRemaining = Infinity;
async function fetchArticles(query, publishedAfter) {
  const url = new URL('https://api.thenewsapi.com/v1/news/all');
  url.searchParams.set('api_token', NEWS_API_KEY);
  url.searchParams.set('search', query);
  url.searchParams.set('language', 'en');
  url.searchParams.set('locale', 'us');
  url.searchParams.set('limit', '25');
  url.searchParams.set('sort', 'relevance_score');
  if (publishedAfter) url.searchParams.set('published_after', publishedAfter);
  for (let attempt = 0; attempt <= 6; attempt++) {
    if (rlRemaining <= 1) { await sleep(60_000); rlRemaining = Infinity; }
    else if (attempt > 0) await sleep(2000 * attempt);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const rem = Number(res.headers.get('x-ratelimit-remaining'));
    if (Number.isFinite(rem)) rlRemaining = rem;
    if (res.ok) {
      const data = await res.json();
      const seen = new Set();
      return (data.data ?? []).map((a) => ({
        title: a.title, url: a.url, source: a.source,
        snippet: a.description ?? a.snippet ?? null,
      })).filter((a) => {
        const t = (a.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (seen.has(t)) return false;
        seen.add(t); return true;
      });
    }
    if (res.status === 429) { await sleep(60_000); rlRemaining = Infinity; continue; }
    if (res.status === 402) throw new Error('quota exhausted');
  }
  throw new Error('exhausted retries');
}

/* Relevance gate — EXACT prompt from scripts/sync-coverage.mjs. */
async function filterRelevant(b, candidates) {
  if (!GATE || candidates.length === 0) return null; // null = not gated
  const list = candidates.map((a, i) => `${i}. ${a.title}${a.snippet ? ` — ${a.snippet}` : ''} (${a.source})`).join('\n');
  const msg = await anthropic.messages.create({
    model: MODEL, max_tokens: 80,
    messages: [{ role: 'user', content: `A US congressional bill:
${b.bill_type.toUpperCase()} ${b.bill_number} — ${b.ai_headline ?? b.title}
What it does: ${b.ai_sections?.tldr ?? b.ai_summary ?? b.title}

Below are news articles. Return ONLY the numbers of articles specifically about THIS bill (its provisions, votes, debate, or signing) — not merely the general topic, and not a different bill. Reply with a comma-separated list of numbers, or "none".

${list}` }],
  });
  const text = (msg.content[0]?.type === 'text' ? msg.content[0].text : '').toLowerCase();
  const keep = new Set(text.split(/[^0-9]+/).filter(Boolean).map(Number).filter((n) => n >= 0 && n < candidates.length));
  return candidates.filter((_, i) => keep.has(i)).slice(0, 5);
}

// ---- run ----
const rows = [];
for (const b of sample) {
  const slug = slugOf(b);
  const after = b.introduced_date ?? '2025-01-03';
  const row = { slug, stratum: strata.get(slug), status: b.status };
  try {
    row.oldQuery = oldQueryFor(b);
    row.newQuery = queryFor(b);
    const oldArts = await fetchArticles(row.oldQuery, after);
    await sleep(1200);
    const newArts = await fetchArticles(row.newQuery, after);
    await sleep(1200);
    row.oldCandidates = oldArts.length;
    row.newCandidates = newArts.length;
    row.oldKept = (await filterRelevant(b, oldArts))?.length ?? null;
    row.newKeptArticles = await filterRelevant(b, newArts);
    row.newKept = row.newKeptArticles?.length ?? null;
    console.log(`${row.stratum.padEnd(8)} ${slug.padEnd(16)} cand ${String(row.oldCandidates).padStart(2)} -> ${String(row.newCandidates).padStart(2)}${GATE ? ` | kept ${row.oldKept} -> ${row.newKept}` : ''}`);
  } catch (e) {
    row.error = e.message;
    console.error(`${slug}: ${e.message}`);
    if (/quota/.test(e.message)) break;
  }
  rows.push(row);
}

// ---- summary ----
const ok = rows.filter((r) => !r.error);
const by = (f) => ok.reduce((n, r) => n + f(r), 0);
const summary = {
  bills: ok.length,
  candidates: { old: by((r) => r.oldCandidates), new: by((r) => r.newCandidates) },
  zeroCandidateBills: { old: ok.filter((r) => r.oldCandidates === 0).length, new: ok.filter((r) => r.newCandidates === 0).length },
  ...(GATE && {
    kept: { old: by((r) => r.oldKept ?? 0), new: by((r) => r.newKept ?? 0) },
    billsWithCoverage: { old: ok.filter((r) => r.oldKept > 0).length, new: ok.filter((r) => r.newKept > 0).length },
    regressions: ok.filter((r) => r.stratum === 'covered' && (r.newKept ?? 0) < (r.oldKept ?? 0)).map((r) => r.slug),
  }),
  byStratum: {},
};
for (const s of new Set(ok.map((r) => r.stratum))) {
  const g = ok.filter((r) => r.stratum === s);
  summary.byStratum[s] = {
    bills: g.length,
    oldCand: g.reduce((n, r) => n + r.oldCandidates, 0),
    newCand: g.reduce((n, r) => n + r.newCandidates, 0),
    ...(GATE && {
      oldKept: g.reduce((n, r) => n + (r.oldKept ?? 0), 0),
      newKept: g.reduce((n, r) => n + (r.newKept ?? 0), 0),
      oldBillsCovered: g.filter((r) => r.oldKept > 0).length,
      newBillsCovered: g.filter((r) => r.newKept > 0).length,
    }),
  };
}

console.log('\n===== SUMMARY =====');
console.log(JSON.stringify(summary, null, 2));
writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
console.log(`\nfull rows: ${OUT}`);
