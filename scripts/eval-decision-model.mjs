/**
 * An OFFLINE comparison of a decision model with the nightly coverage
 * relevance gate. Nothing in production calls this file, and it changes no
 * production call site, model id, price constant or workflow.
 *
 * The question both sides answer, per (bill, article) pair: is this article
 * specifically about THIS bill (its provisions, votes, debate or signing), not
 * merely its general topic and not a different bill?
 *
 * Where the set and the results live is always given by you, never guessed:
 * --out DIR (or DECISION_EVAL_OUT) for --build-set, --set DIR (or
 * DECISION_EVAL_SET) for every other mode. With neither, the script says which
 * flag to pass and exits 2. A folder inside the repo is refused.
 *
 * Run it as a file (node scripts/eval-decision-model.mjs ...): it finds the
 * repo root from its own location. Imported, or started through node -e, it has
 * no location and refuses to do anything unless the caller passes the root.
 * The inside-the-repo test follows symlinks (real paths on both sides).
 *
 * Exit codes: 0 done; 1 no key or an unexpected error; 2 refused (a guard, a
 * bad argument, a missing --set or --out); 3 --run finished but at least one
 * arm had no successful request.
 *
 *   --build-set --out DIR [--seed N]          the labelled-pair set, without labels (no network)
 *   --import-labels FILE|DIR --labeller NAME --set DIR
 *                                             store one labeller's {pairId, label} lines
 *   --label --set DIR --labeller NAME [--limit N] [--sample SEED]
 *                                             label pairs by hand in the terminal
 *   --agreement --set DIR [--judges A,B]      agreement and Cohen's kappa between labellers
 *   --plan --set DIR [--repeat N]             the cost estimate; needs no key, sends nothing
 *   --probe --set DIR                         one tiny request to each endpoint; saves the raw shapes
 *   --run --set DIR [--repeat N] [--judges A,B]
 *                                             both arms over the set (needs OPENROUTER_API_KEY)
 *   --score --set DIR [--judges A,B]          report.md + report.json (offline)
 *
 * Two arms, sent through one gateway (OpenRouter), stdlib fetch only:
 *   - the gate arm: the nightly gate's model (sync-coverage.mjs `MODEL`) at
 *     the chat-completions endpoint, sent production's own relevancePrompt
 *     (imported, never copied) with production's max_tokens, no temperature
 *     and no system prompt, read with production's parseKeptIndexes and
 *     gateAnswered;
 *   - the decision arm: the decisions endpoint, one yes/no ("noul") question
 *     per article, the bill's facts as `state`, the same lists in the same
 *     order.
 *
 * Where results go: never inside the repo (rule 11). Every mode refuses a
 * directory that resolves inside the repo root. Run as a command, the root is
 * found from this file's own location (not the working directory), so the
 * refusal is the same from any folder.
 *
 * The key (rule 10): read only from env.OPENROUTER_API_KEY, used only to set
 * the Authorization header inside `send`, never printed. Every log line, error
 * and file written passes through redact(). The key is local-only: it is not a
 * Vercel or Actions secret and never goes in .env.local
 * (docs/runbooks/secrets.md).
 *
 * Spend guards, all in code, before anything is sent: gold labels complete;
 * the estimate at or under COST_CEILING_USD (no override); a key set; the key
 * itself capped (GET /api/v1/key shows a `limit`, at most KEY_LIMIT_MAX_USD).
 * While running: a hard request cap per arm, retries counted as sent, and a
 * stop when the summed usage.cost passes the ceiling.
 *
 * No `import.meta` and no top-level await: tests/eval-decision-model.unit.spec.ts
 * imports this file through Playwright's transform.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { leanOf } from '../lib/conversation.mjs';
import { MODEL_PRICE_PER_MTOK } from '../lib/pipeline-health.mjs';
import { coverageSlug, gateAnswered, parseKeptIndexes, relevancePrompt } from './coverage-query.mjs';

// ---- constants -----------------------------------------------------------

/** The nightly relevance gate's model (scripts/sync-coverage.mjs `MODEL`). A test keeps the two tied. */
export const GATE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * The gateway's name for each Anthropic model id this harness may send.
 * UNVERIFIED until --probe runs with a real key: the slug, and the provider
 * pin below. A test asserts the gate's current model has an entry here.
 */
export const OPENROUTER_SLUG = Object.freeze({
  'claude-haiku-4-5-20251001': 'anthropic/claude-haiku-4.5',
});

/** Pins the gate arm to Anthropic itself, no fallback provider (UNVERIFIED field names). */
export const GATE_PROVIDER = Object.freeze({ order: ['anthropic'], allow_fallbacks: false });

export const DECISION_MODEL = 'typesafe/jev-1.13';

export const OPENROUTER = Object.freeze({
  chat: 'https://openrouter.ai/api/v1/chat/completions',
  decisions: 'https://openrouter.ai/api/alpha/decisions',
  key: 'https://openrouter.ai/api/v1/key',
});

/** List price per million tokens. The gate's row is the repo's one price table. */
export const PRICE = Object.freeze({
  gate: MODEL_PRICE_PER_MTOK['claude-haiku-4-5'],
  // From the model's page on the gateway, 2026-09-29: $0.042 in, output free.
  decision: Object.freeze({ input: 0.042, output: 0 }),
});

/** No run starts above this estimate, and a run stops when its billed cost passes it. No override. */
export const COST_CEILING_USD = 3;

/** The key must carry its own spending limit, at most this. */
export const KEY_LIMIT_MAX_USD = 5;

/** Characters per token for the estimate. English runs nearer 4, so 3 reads high on purpose. */
export const CHARS_PER_TOKEN = 3;

/** Production's per-bill candidate cap (sync-coverage.mjs MAX_CANDIDATES default). */
export const MAX_CANDIDATES = 25;

/** Retries per request on 429 or a 5xx. Each counts as a request sent. */
export const MAX_RETRIES = 2;

/** Bill lists a night asks the gate about (the nightly TOP_N budget, 2026-09-29). */
export const NIGHTLY_CALLS = 571;

export const SET_TARGET = Object.freeze({ pairs: 640, stored: 0.45, hard: 0.35, easy: 0.2 });

export const BOOTSTRAP_RESAMPLES = 2000;

/** Below this many gold pairs the report says the head-to-head is underpowered. */
export const POWER_MIN_GOLD = 400;

export const DEFAULT_SEED = 20260929;

export const QUESTION =
  'Is this article specifically about THIS bill (its provisions, votes, debate or signing), not merely its general topic and not a different bill?';

export const LABELS = Object.freeze(['yes', 'no', 'unsure']);

/** Exit code of --run when at least one arm had no successful request. */
export const EXIT_ARM_FAILED = 3;

// ---- small helpers -------------------------------------------------------

const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
const round4 = (n) => Math.round(n * 10_000) / 10_000;
const usd = (n) => `$${Number(n).toFixed(4)}`;

/** A seeded generator (mulberry32). Same seed, same sequence. */
export function rngFor(seed) {
  let a = Number(seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates on a copy. */
export function shuffled(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Which half a bill belongs to: hash(slug) mod 2. Fixed, not seeded, so no bill is ever in both. */
export function halfOf(slug) {
  return parseInt(sha1(String(slug).toLowerCase()).slice(0, 8), 16) % 2 === 0 ? 'tune' : 'test';
}

export function pairIdFor(slug, url) {
  return `p${sha1(`${slug}\n${url}`).slice(0, 12)}`;
}

/**
 * Remove the key, and any bearer token, from text. Everything logged or
 * written passes through here.
 */
export function redact(text, key) {
  let s = String(text ?? '');
  if (key && String(key).length >= 4) s = s.split(String(key)).join('[REDACTED]');
  return s.replace(/(Bearer\s+)[^\s"'\\,}]+/gi, '$1[REDACTED]').replace(/sk-or-[A-Za-z0-9_-]+/g, '[REDACTED]');
}

/**
 * The real location of a path, symlinks resolved, even when the tail does not
 * exist yet: resolve the deepest ancestor that exists, then put the missing
 * part back. Returns null for a dangling symlink (its target is unknown).
 */
export function realPathOf(p) {
  let cur = resolve(p);
  const rest = [];
  for (;;) {
    if (existsSync(cur)) break;
    try {
      lstatSync(cur);
      return null; // the name exists but points nowhere
    } catch {
      // the name does not exist; go up
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.unshift(basename(cur));
    cur = parent;
  }
  let real = cur;
  try {
    real = realpathSync(cur);
  } catch {
    return null;
  }
  return join(real, ...rest);
}

/**
 * True when `dir` is the repo root or anywhere under it, by real location
 * (symlinks followed on both sides). Fails closed: a path that cannot be
 * resolved counts as inside.
 */
export function isInsideRepo(dir, root) {
  const realRoot = realPathOf(root);
  const realDir = realPathOf(resolve(root, dir));
  if (!realRoot || !realDir) return true;
  const rel = relative(realRoot, realDir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Did this row's request give a usable answer? A decision row needs at least
 * one probability; a gate row needs a reply with choices. Used by --run for its
 * count and by --score to refuse an arm with none.
 */
export function rowSucceeded(arm, row) {
  if (!row || row.error) return false;
  if (arm === 'decision') return Array.isArray(row.probabilities) && row.probabilities.some((x) => x.p !== null);
  try {
    const c = JSON.parse(row.raw)?.choices;
    return Array.isArray(c) && c.length > 0;
  } catch {
    return false;
  }
}

/** The article as production formats a candidate (fetchArticles in sync-coverage.mjs). */
export function asCandidate(a) {
  return {
    title: a?.title ?? '',
    url: a?.url ?? '',
    source: a?.source ?? '',
    snippet: a?.snippet ?? null,
    publishedAt: isDay(a?.publishedAt) ? a.publishedAt : null,
  };
}

/** The bill facts relevancePrompt shows, as fields (the decision arm's `state`, and the judge packets). */
export function billBlock(b) {
  const action = oneLine(b?.last_action_text).slice(0, 200);
  return {
    bill: `${String(b?.bill_type ?? '').toUpperCase()} ${b?.bill_number ?? ''}`.trim(),
    headline: b?.ai_headline ?? b?.title ?? '',
    whatItDoes: b?.ai_sections?.tldr ?? b?.ai_summary ?? b?.title ?? '',
    introduced: isDay(b?.introduced_date) ? b.introduced_date : 'unknown',
    latestActionDate: isDay(b?.last_action_date) ? b.last_action_date : 'undated',
    latestAction: action || 'none recorded',
  };
}

/** The bill fields the set keeps, so a later change to data/bills.json never moves it. */
const BILL_FIELDS = [
  'bill_type', 'bill_number', 'congress_number', 'title', 'short_title', 'ai_headline', 'ai_summary',
  'introduced_date', 'last_action_date', 'last_action_text', 'status', 'policy_area', 'issue_tags', 'press_names',
];
function billSnapshot(b) {
  const out = {};
  for (const k of BILL_FIELDS) if (b[k] !== undefined) out[k] = b[k];
  out.ai_sections = { tldr: b.ai_sections?.tldr ?? null };
  return out;
}

// ---- 1. the set ----------------------------------------------------------

const norm = (s) => oneLine(s).toLowerCase();

/** Do two bills look like companions (the same measure in each chamber, or a sibling)? */
export function looksCompanion(a, b) {
  if (!a || !b) return false;
  const st = (x) => norm(x.short_title);
  if (st(a) && st(a) === st(b)) return true;
  if (norm(a.title) && norm(a.title) === norm(b.title)) return true;
  const pa = new Set((a.press_names ?? []).map(norm).filter(Boolean));
  return (b.press_names ?? []).map(norm).some((n) => n && pa.has(n));
}

/** Do two bills share a policy area or an issue tag? */
export function sharesTopic(a, b) {
  if (!a || !b) return false;
  if (a.policy_area && a.policy_area === b.policy_area) return true;
  const tags = new Set(a.issue_tags ?? []);
  return (b.issue_tags ?? []).some((t) => tags.has(t));
}

/**
 * Build the pair set. Pure and deterministic for a seed.
 *
 * Stored pairs are (bill, article) as data/coverage.json holds them. Swap
 * pairs show an article stored for bill A to bill B, never when the same URL
 * is stored under B, and never when B looks like a companion of any bill the
 * URL is stored under. A hard swap's A shares B's policy area or an issue
 * tag; an easy swap's A shares neither. Each URL is used in at most one swap.
 *
 * Bills are taken in seeded random order, each bringing all its stored
 * articles, until the stored share of the target is reached; swaps are then
 * spread round-robin over those bills. Lists never pass MAX_CANDIDATES.
 *
 * @param {{ coverage: any, bills: any[], mediaBias: any, seed?: number, target?: typeof SET_TARGET }} input
 */
export function buildSet({ coverage, bills, mediaBias, seed = DEFAULT_SEED, target = SET_TARGET }) {
  const rng = rngFor(seed);
  const outlets = mediaBias?.outlets ?? {};
  const billBySlug = new Map((bills ?? []).map((b) => [coverageSlug(b), b]));
  /** @type {Map<string, {slug: string, articles: any[]}>} */
  const stored = new Map();
  /** @type {Map<string, {article: any, under: Set<string>}>} */
  const byUrl = new Map();
  for (const slug of Object.keys(coverage ?? {}).sort()) {
    if (slug.startsWith('_')) continue;
    const list = Array.isArray(coverage[slug]) ? coverage[slug].filter((a) => a?.url) : [];
    if (!list.length || !billBySlug.has(slug)) continue;
    stored.set(slug, { slug, articles: list });
    for (const a of list) {
      const e = byUrl.get(a.url) ?? { article: a, under: new Set() };
      e.under.add(slug);
      byUrl.set(a.url, e);
    }
  }

  const want = {
    stored: Math.round(target.pairs * target.stored),
    hard: Math.round(target.pairs * target.hard),
    easy: target.pairs - Math.round(target.pairs * target.stored) - Math.round(target.pairs * target.hard),
  };

  // Bills, in seeded order, until the stored share is reached. The next bill
  // always comes from whichever half holds fewer stored pairs so far, so the
  // two halves stay near equal in size (the hash alone split today's 451
  // bills 251/200).
  const order = shuffled([...stored.keys()], rng);
  const queues = { tune: order.filter((s) => halfOf(s) === 'tune'), test: order.filter((s) => halfOf(s) === 'test') };
  const chosen = [];
  const perHalf = { tune: 0, test: 0 };
  let storedCount = 0;
  while (storedCount < want.stored && (queues.tune.length || queues.test.length)) {
    const h = !queues.test.length ? 'tune' : !queues.tune.length ? 'test' : perHalf.tune <= perHalf.test ? 'tune' : 'test';
    const slug = /** @type {string} */ (queues[h].shift());
    chosen.push(slug);
    const n = Math.min(stored.get(slug).articles.length, MAX_CANDIDATES);
    perHalf[h] += n;
    storedCount += n;
  }

  /** @type {Map<string, {pairId: string, slug: string, article: any, origin: string, stratum: string}[]>} */
  const lists = new Map(chosen.map((s) => [s, []]));
  const pairs = [];
  const add = (slug, article, origin, stratum, storedUnder) => {
    const list = lists.get(slug);
    if (list.length >= MAX_CANDIDATES || list.some((p) => p.article.url === article.url)) return false;
    const cand = asCandidate(article);
    const p = {
      pairId: pairIdFor(slug, cand.url),
      slug,
      half: halfOf(slug),
      origin,
      stratum,
      rated: leanOf(cand.source, outlets) ? 'rated' : 'unrated',
      storedUnder: [...storedUnder].sort(),
      article: cand,
    };
    list.push(p);
    pairs.push(p);
    return true;
  };
  for (const slug of chosen) {
    for (const a of stored.get(slug).articles) add(slug, a, 'stored', 'stored', byUrl.get(a.url).under);
  }

  // Swap pools, shuffled once.
  const urls = shuffled([...byUrl.keys()].sort(), rng);
  const usedSwap = new Set();
  const eligible = (slug, url, kind) => {
    if (usedSwap.has(url)) return false;
    const e = byUrl.get(url);
    if (e.under.has(slug)) return false;
    const B = billBySlug.get(slug);
    const owners = [...e.under].map((s) => billBySlug.get(s));
    if (owners.some((A) => looksCompanion(A, B))) return false;
    const topical = owners.some((A) => sharesTopic(A, B));
    return kind === 'hard' ? topical : !topical;
  };
  const shortfall = { hard: 0, easy: 0 };
  for (const kind of /** @type {const} */ (['hard', 'easy'])) {
    let placed = 0;
    let stuck = new Set();
    let i = 0;
    const billOrder = shuffled(chosen, rng);
    while (placed < want[kind] && stuck.size < billOrder.length) {
      const slug = billOrder[i++ % billOrder.length];
      if (stuck.has(slug)) continue;
      const url = urls.find((u) => eligible(slug, u, kind) && !lists.get(slug).some((p) => p.article.url === u));
      if (!url || lists.get(slug).length >= MAX_CANDIDATES) {
        stuck.add(slug);
        continue;
      }
      usedSwap.add(url);
      add(slug, byUrl.get(url).article, 'swap', kind === 'hard' ? 'hard-swap' : 'easy-swap', byUrl.get(url).under);
      placed++;
    }
    shortfall[kind] = want[kind] - placed;
  }

  // Each list in production's shape: shuffled, capped.
  const listOut = chosen.map((slug) => ({ slug, half: halfOf(slug), pairIds: shuffled(lists.get(slug), rng).map((p) => p.pairId) }));
  const pairOrder = new Map(listOut.flatMap((l) => l.pairIds.map((id, i) => [id, `${l.slug}\u0000${String(i).padStart(3, '0')}`])));
  pairs.sort((a, b) => (pairOrder.get(a.pairId) < pairOrder.get(b.pairId) ? -1 : 1));

  const snapshot = Object.fromEntries(chosen.map((s) => [s, billSnapshot(billBySlug.get(s))]));
  return { seed, target, want, shortfall, pairs, lists: listOut, bills: snapshot, summary: summarizeSet(pairs) };
}

export function summarizeSet(pairs) {
  const count = (f) => pairs.reduce((m, p) => ((m[f(p)] = (m[f(p)] ?? 0) + 1), m), /** @type {Record<string, number>} */ ({}));
  return {
    pairs: pairs.length,
    bills: new Set(pairs.map((p) => p.slug)).size,
    uniqueUrls: new Set(pairs.map((p) => p.article.url)).size,
    byOrigin: count((p) => p.origin),
    byStratum: count((p) => p.stratum),
    byRated: count((p) => p.rated),
    byHalf: count((p) => p.half),
    billsByHalf: [...new Set(pairs.map((p) => p.slug))].reduce((m, s) => ((m[halfOf(s)] = (m[halfOf(s)] ?? 0) + 1), m), /** @type {Record<string, number>} */ ({})),
  };
}

// ---- reading and writing a set -------------------------------------------

const readJsonl = (path) =>
  readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

export function loadSet(dir) {
  const meta = JSON.parse(readFileSync(join(dir, 'set.json'), 'utf8'));
  const pairs = readJsonl(join(dir, 'pairs.jsonl'));
  return { ...meta, pairs, pairById: new Map(pairs.map((p) => [p.pairId, p])) };
}

/** The candidate lists, in the set's order, with the bill each belongs to. */
export function listsOf(set) {
  return set.lists.map((l) => ({
    slug: l.slug,
    half: l.half,
    bill: set.bills[l.slug],
    pairs: l.pairIds.map((id) => set.pairById.get(id)),
  }));
}

const RESULTS_DIR = 'results';
const LABELLERS_DIR = 'labellers';

function resultsExist(dir) {
  const d = join(dir, RESULTS_DIR);
  return existsSync(d) && readdirSync(d).some((f) => statSync(join(d, f)).isFile());
}

// ---- 2 & 3. labels -------------------------------------------------------

/**
 * Read labeller lines ({pairId, label, ...}). Unknown pairs, bad labels and
 * repeats are problems, not labels; the first line for a pair wins.
 */
export function parseLabels(rows, pairIds) {
  const labels = new Map();
  const problems = [];
  for (const r of rows) {
    const id = r?.pairId;
    const label = String(r?.label ?? '').toLowerCase();
    if (!pairIds.has(id)) problems.push(`unknown pairId ${String(id).slice(0, 40)}`);
    else if (!LABELS.includes(label)) problems.push(`${id}: label "${String(r?.label).slice(0, 20)}" is not yes, no or unsure`);
    else if (labels.has(id)) problems.push(`${id}: labelled more than once; the first line kept`);
    else labels.set(id, label);
  }
  return { labels, problems };
}

function readLabelSource(path) {
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .flatMap((f) => readJsonl(join(path, f)));
  }
  return readJsonl(path);
}

const safeName = (n) => /^[a-z0-9][a-z0-9_-]{0,40}$/i.test(String(n ?? ''));

export function loadLabellers(dir) {
  const d = join(dir, LABELLERS_DIR);
  /** @type {Map<string, Map<string, string>>} */
  const out = new Map();
  if (!existsSync(d)) return out;
  for (const f of readdirSync(d).filter((x) => x.endsWith('.jsonl')).sort()) {
    out.set(f.replace(/\.jsonl$/, ''), new Map(readJsonl(join(d, f)).map((r) => [r.pairId, r.label])));
  }
  return out;
}

/** The terminal text for one pair. Origin and stratum are never shown. */
export function labelCard(pair, bill, i, n) {
  const b = billBlock(bill);
  const a = pair.article;
  return [
    '',
    `---- ${i + 1} of ${n} ----`,
    `BILL ${b.bill}: ${b.headline}`,
    `What it does: ${b.whatItDoes}`,
    `Introduced: ${b.introduced}. Latest action (${b.latestActionDate}): ${b.latestAction}`,
    '',
    `ARTICLE [${a.publishedAt ?? 'undated'}] ${a.title}`,
    a.snippet ? `  ${a.snippet}` : '  (no snippet)',
    `  ${a.source}  ${a.url}`,
    '',
    QUESTION,
    'y = yes, n = no, u = unsure, s = skip, q = quit',
  ].join('\n');
}

/**
 * A labelling session. `lines` is an async iterable of answers. Returns the
 * labels given; the caller appends them.
 */
export async function labelSession({ set, already, lines, write, limit = Infinity, sampleSeed = null }) {
  let todo = set.pairs.filter((p) => !already.has(p.pairId));
  todo = shuffled(todo, rngFor(sampleSeed ?? Date.now()));
  if (Number.isFinite(limit)) todo = todo.slice(0, Math.max(0, limit));
  const out = [];
  const it = lines[Symbol.asyncIterator]();
  for (let i = 0; i < todo.length; i++) {
    const p = todo[i];
    write(labelCard(p, set.bills[p.slug], i, todo.length));
    for (;;) {
      write('> ');
      const next = await it.next();
      if (next.done) return out;
      const k = String(next.value).trim().toLowerCase();
      if (k === 'q') return out;
      if (k === 's') break;
      const label = { y: 'yes', n: 'no', u: 'unsure' }[k];
      if (label) {
        out.push({ pairId: p.pairId, label });
        break;
      }
      write('Please type y, n, u, s or q.');
    }
  }
  return out;
}

// ---- 4. agreement --------------------------------------------------------

/** Cohen's kappa over the pairs both labellers labelled. */
export function cohenKappa(a, b) {
  const ids = [...a.keys()].filter((id) => b.has(id));
  const n = ids.length;
  if (!n) return { n: 0, agreement: null, kappa: null };
  let same = 0;
  const pa = {};
  const pb = {};
  for (const id of ids) {
    const x = a.get(id);
    const y = b.get(id);
    if (x === y) same++;
    pa[x] = (pa[x] ?? 0) + 1;
    pb[y] = (pb[y] ?? 0) + 1;
  }
  const po = same / n;
  const pe = LABELS.reduce((s, l) => s + ((pa[l] ?? 0) / n) * ((pb[l] ?? 0) / n), 0);
  return { n, agreement: po, kappa: pe === 1 ? null : (po - pe) / (1 - pe) };
}

/**
 * Gold labels: every judge labelled the pair, all gave the same answer, and
 * it was yes or no. Needs at least two judges.
 */
export function goldLabels(set, labellers, judges) {
  const gold = new Map();
  const counts = { pairs: set.pairs.length, gold: 0, missing: 0, disagree: 0, unsure: 0 };
  if (judges.length < 2) return { gold, counts, complete: false, judges };
  for (const p of set.pairs) {
    const ls = judges.map((j) => labellers.get(j)?.get(p.pairId));
    if (ls.some((l) => !l)) counts.missing++;
    else if (ls.includes('unsure')) counts.unsure++;
    else if (new Set(ls).size > 1) counts.disagree++;
    else {
      gold.set(p.pairId, ls[0]);
      counts.gold++;
    }
  }
  return { gold, counts, complete: counts.missing === 0, judges };
}

function judgesFrom(argv, labellers) {
  const named = argValue(argv, '--judges');
  if (named) return named.split(',').map((s) => s.trim()).filter(Boolean);
  // Default: every labeller but the owner's hand check.
  return [...labellers.keys()].filter((n) => !/^owner/i.test(n)).sort();
}

export function agreementReport(set, labellers, judges) {
  const names = [...labellers.keys()].sort();
  const pairsTable = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      pairsTable.push({ a: names[i], b: names[j], ...cohenKappa(labellers.get(names[i]), labellers.get(names[j])) });
    }
  }
  const g = goldLabels(set, labellers, judges);
  const vsGold = names
    .filter((n) => !judges.includes(n))
    .map((n) => ({ labeller: n, ...cohenKappa(labellers.get(n), g.gold) }));
  return { labellers: names.map((n) => ({ name: n, labelled: labellers.get(n).size })), judges, pairwise: pairsTable, gold: g.counts, vsGold };
}

// ---- 5. the plan ---------------------------------------------------------

export const gateMaxTokens = (n) => Math.max(80, 4 * n);

/** The decision arm's request body for one list. */
export function decisionRequest(bill, pairs) {
  const questions = {};
  pairs.forEach((p, i) => {
    const a = p.article;
    questions[`article_${i}`] = {
      type: 'noul',
      instructions:
        `${QUESTION}\nArticle ${i}: [${a.publishedAt ?? 'undated'}] ${a.title}${a.snippet ? ` — ${a.snippet}` : ''} (${a.source})`,
      criteria: {
        true: 'The article is specifically about this bill: its provisions, votes, debate or signing.',
        false: 'The article is only about the general topic, or about a different bill or measure.',
      },
    };
  });
  return { model: DECISION_MODEL, state: billBlock(bill), questions };
}

/** The gate arm's request body for one list: production's prompt and max_tokens, nothing added. */
export function gateRequest(bill, pairs) {
  const candidates = pairs.map((p) => p.article);
  return {
    model: OPENROUTER_SLUG[GATE_MODEL],
    provider: { ...GATE_PROVIDER },
    max_tokens: gateMaxTokens(candidates.length),
    messages: [{ role: 'user', content: relevancePrompt(bill, candidates) }],
  };
}

export const costUsd = (inTok, outTok, price) => (inTok * price.input + outTok * price.output) / 1_000_000;

export function planRun(set, { repeat = 1 } = {}) {
  const lists = listsOf(set);
  let gateIn = 0;
  let gateOut = 0;
  let decIn = 0;
  for (const l of lists) {
    gateIn += Math.ceil(relevancePrompt(l.bill, l.pairs.map((p) => p.article)).length / CHARS_PER_TOKEN);
    gateOut += gateMaxTokens(l.pairs.length);
    decIn += Math.ceil(JSON.stringify(decisionRequest(l.bill, l.pairs)).length / CHARS_PER_TOKEN);
  }
  const gateOnce = costUsd(gateIn, gateOut, PRICE.gate);
  const dec = costUsd(decIn, 0, PRICE.decision);
  return {
    lists: lists.length,
    pairs: set.pairs.length,
    repeat,
    gate: { inputTokens: gateIn, outputTokensMax: gateOut, usdOnce: gateOnce, usd: gateOnce * repeat },
    decision: { inputTokens: decIn, usd: dec },
    totalUsd: gateOnce * repeat + dec,
    requestCap: { gate: 2 * lists.length * repeat, decision: 2 * lists.length },
  };
}

function printPlan(plan, log) {
  log(`PLAN: ${plan.pairs} pairs in ${plan.lists} bill lists. Gate arm repeated ${plan.repeat}x.`);
  log(
    `  gate arm (${GATE_MODEL} via ${OPENROUTER_SLUG[GATE_MODEL]}): ~${plan.gate.inputTokens} input tokens + at most ${plan.gate.outputTokensMax} output tokens per pass ` +
      `= ${usd(plan.gate.usdOnce)} per pass at list price ($${PRICE.gate.input}/$${PRICE.gate.output} per M), ${usd(plan.gate.usd)} for ${plan.repeat}`,
  );
  log(`  decision arm (${DECISION_MODEL}): ~${plan.decision.inputTokens} input tokens, output free = ${usd(plan.decision.usd)} ($${PRICE.decision.input} per M in)`);
  log(`  TOTAL ESTIMATE: ${usd(plan.totalUsd)} (ceiling ${usd(COST_CEILING_USD)}; ${CHARS_PER_TOKEN} characters per token, assumed; output at max_tokens)`);
  log(`  request caps, retries counted as sent: gate ${plan.requestCap.gate}, decision ${plan.requestCap.decision}`);
  log('--plan: nothing sent, no key read.');
}

// ---- 6 & 7. sending ------------------------------------------------------

/** The gate reply's stop reason in the Anthropic vocabulary gateAnswered expects. */
export function stopReasonOf(choice) {
  const native = choice?.native_finish_reason;
  if (typeof native === 'string' && native) return native;
  const f = choice?.finish_reason;
  if (f === 'stop') return 'end_turn';
  if (f === 'length') return 'max_tokens';
  if (f === 'content_filter') return 'refusal';
  return f ?? null;
}

/** The yes-probability for one noul answer (documented shape: {type: 'noul', noul: 0.96}). */
export function noulProbability(answer) {
  const v = answer?.noul ?? answer?.probability;
  return typeof v === 'number' && v >= 0 && v <= 1 ? v : null;
}

/**
 * Send one request with the retry rule. `budget` counts every attempt as a
 * request sent and refuses once it is spent.
 */
async function send({ url, body, method = 'POST', key, fetchImpl, budget }) {
  let last = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (budget.sent >= budget.cap) return { error: `not sent: the ${budget.cap}-request cap was reached`, status: null };
    budget.sent++;
    const t0 = performance.now();
    try {
      const res = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const ms = performance.now() - t0;
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (res.ok) return { status: res.status, json, raw: text, ms };
      last = { status: res.status, error: `HTTP ${res.status}: ${oneLine(text).slice(0, 300)}`, ms };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (e) {
      last = { status: null, error: `request failed: ${oneLine(e instanceof Error ? e.message : e).slice(0, 300)}` };
    }
  }
  return last;
}

/** GET the key's own limits. Free. */
async function checkKey({ key, fetchImpl, log }) {
  const r = await send({ url: OPENROUTER.key, method: 'GET', key, fetchImpl, budget: { sent: 0, cap: 1 + MAX_RETRIES } });
  if (!r?.json) return { ok: false, why: `the key check failed (${redact(r?.error ?? 'no reply', key)})` };
  const d = r.json.data ?? r.json;
  const limit = d?.limit;
  if (typeof limit !== 'number') return { ok: false, why: 'the key has no spending limit set; set one at or under $5 first' };
  if (limit > KEY_LIMIT_MAX_USD) return { ok: false, why: `the key's limit is $${limit}, above $${KEY_LIMIT_MAX_USD}` };
  log(`key check: limit $${limit}, remaining ${d?.limit_remaining ?? 'unknown'}`);
  return { ok: true, limit, remaining: d?.limit_remaining ?? null };
}

function writeOut(path, content, key) {
  writeFileSync(path, redact(content, key));
}

export async function runArms({ set, key, fetchImpl, repeat = 1, log = () => {}, dir }) {
  const lists = listsOf(set);
  const resultsDir = join(dir, RESULTS_DIR);
  mkdirSync(resultsDir, { recursive: true });
  let spent = 0;
  const over = () => spent > COST_CEILING_USD;
  const summary = { gate: { sent: 0, cap: 0, usd: 0, ok: 0, failed: 0 }, decision: { sent: 0, cap: 0, usd: 0, ok: 0, failed: 0 }, stoppedOnCost: false };

  // Decision arm.
  const decBudget = { sent: 0, cap: 2 * lists.length };
  const decRows = [];
  for (const l of lists) {
    if (over()) {
      summary.stoppedOnCost = true;
      break;
    }
    const r = await send({ url: OPENROUTER.decisions, body: decisionRequest(l.bill, l.pairs), key, fetchImpl, budget: decBudget });
    const cost = Number(r?.json?.usage?.cost) || 0;
    spent += cost;
    summary.decision.usd += cost;
    const answers = r?.json?.answers ?? {};
    decRows.push({
      slug: l.slug,
      ms: r?.ms ?? null,
      error: r?.error ?? null,
      usage: r?.json?.usage ?? null,
      probabilities: l.pairs.map((p, i) => ({ pairId: p.pairId, p: noulProbability(answers[`article_${i}`]) })),
      raw: r?.raw ?? null,
    });
    log(`decision ${l.slug}: ${r?.error ? redact(r.error, key) : `${l.pairs.length} answered`}`);
  }
  writeOut(join(resultsDir, 'decision.jsonl'), jsonl(decRows), key);
  summary.decision.sent = decBudget.sent;
  summary.decision.ok = decRows.filter((r) => rowSucceeded('decision', r)).length;
  summary.decision.failed = decRows.length - summary.decision.ok;
  summary.decision.cap = decBudget.cap;

  // Gate arm, `repeat` passes.
  const gateBudget = { sent: 0, cap: 2 * lists.length * repeat };
  const gateRows = [];
  for (let rep = 0; rep < repeat; rep++) {
    for (const l of lists) {
      if (over()) {
        summary.stoppedOnCost = true;
        break;
      }
      const r = await send({ url: OPENROUTER.chat, body: gateRequest(l.bill, l.pairs), key, fetchImpl, budget: gateBudget });
      const cost = Number(r?.json?.usage?.cost) || 0;
      spent += cost;
      summary.gate.usd += cost;
      const choice = r?.json?.choices?.[0];
      const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
      const stopReason = stopReasonOf(choice);
      const kept = parseKeptIndexes(text, l.pairs.length);
      const inTok = Number(r?.json?.usage?.prompt_tokens) || 0;
      const outTok = Number(r?.json?.usage?.completion_tokens) || 0;
      gateRows.push({
        rep,
        slug: l.slug,
        ms: r?.ms ?? null,
        error: r?.error ?? null,
        usage: r?.json?.usage ?? null,
        listPriceUsd: costUsd(inTok, outTok, PRICE.gate),
        stopReason,
        answered: !r?.error && gateAnswered(text, l.pairs.length, { stopReason }),
        kept: l.pairs.map((p, i) => ({ pairId: p.pairId, kept: r?.error ? null : kept.has(i) })),
        raw: r?.raw ?? null,
      });
      log(`gate[${rep}] ${l.slug}: ${r?.error ? redact(r.error, key) : `${kept.size} of ${l.pairs.length} kept`}`);
    }
  }
  writeOut(join(resultsDir, 'gate.jsonl'), jsonl(gateRows), key);
  summary.gate.sent = gateBudget.sent;
  summary.gate.ok = gateRows.filter((r) => rowSucceeded('gate', r)).length;
  summary.gate.failed = gateRows.length - summary.gate.ok;
  summary.gate.cap = gateBudget.cap;
  writeOut(join(resultsDir, 'run.json'), `${JSON.stringify(summary, null, 2)}\n`, key);
  return summary;
}

// ---- 8. scoring ----------------------------------------------------------

export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Two-sided exact McNemar p-value from the discordant counts. */
export function mcnemar(b, c) {
  const n = b + c;
  if (!n) return 1;
  const k = Math.min(b, c);
  let logC = 0;
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    sum += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * sum);
}

/** Confusion counts and figures for predictions (true = says yes) against gold (true = yes). */
export function metrics(rows) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const { pred, gold } of rows) {
    if (pred && gold) tp++;
    else if (pred && !gold) fp++;
    else if (!pred && gold) fn++;
    else tn++;
  }
  const n = tp + fp + tn + fn;
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall ? (2 * precision * recall) / (precision + recall) : null;
  return {
    n, tp, fp, tn, fn,
    accuracy: n ? (tp + tn) / n : null,
    accuracyCI: wilson(tp + tn, n),
    precision,
    precisionCI: wilson(tp, tp + fp),
    recall,
    recallCI: wilson(tp, tp + fn),
    f1,
  };
}

/**
 * The threshold, from TUNE-half rows only ({p, gold}). Policy, fixed before
 * any run: the smallest t whose precision is at least the gate's tune-half
 * precision (showing an off-topic article is the known failure). If no t
 * reaches it, the t with the highest precision, flagged. The F1-best t is
 * returned as the secondary figure.
 */
export function chooseThreshold(tuneRows, gatePrecision) {
  const rows = tuneRows.filter((r) => typeof r.p === 'number');
  const ts = [...new Set(rows.map((r) => r.p))].sort((a, b) => a - b);
  let policy = null;
  let best = null;
  let f1Best = null;
  for (const t of ts) {
    const m = metrics(rows.map((r) => ({ pred: r.p >= t, gold: r.gold })));
    if (m.precision === null) continue;
    if (policy === null && gatePrecision !== null && m.precision >= gatePrecision) policy = t;
    if (!best || m.precision > best.precision) best = { t, precision: m.precision };
    if (m.f1 !== null && (!f1Best || m.f1 > f1Best.f1)) f1Best = { t, f1: m.f1 };
  }
  return {
    t: policy ?? best?.t ?? 0.5,
    policyMet: policy !== null,
    gatePrecision,
    f1Best: f1Best?.t ?? null,
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/** Bill-clustered bootstrap of each arm's accuracy and the difference. */
export function clusteredBootstrap(rows, { resamples = BOOTSTRAP_RESAMPLES, seed = DEFAULT_SEED } = {}) {
  const bySlug = new Map();
  for (const r of rows) bySlug.set(r.slug, [...(bySlug.get(r.slug) ?? []), r]);
  const slugs = [...bySlug.keys()].sort();
  if (!slugs.length) return null;
  const rng = rngFor(seed);
  const acc = { model: [], gate: [], diff: [] };
  for (let i = 0; i < resamples; i++) {
    let n = 0;
    let m = 0;
    let g = 0;
    for (let j = 0; j < slugs.length; j++) {
      for (const r of bySlug.get(slugs[Math.floor(rng() * slugs.length)])) {
        n++;
        if (r.model === r.gold) m++;
        if (r.gate === r.gold) g++;
      }
    }
    acc.model.push(m / n);
    acc.gate.push(g / n);
    acc.diff.push((m - g) / n);
  }
  const ci = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return [quantile(s, 0.025), quantile(s, 0.975)];
  };
  return { resamples, clusters: slugs.length, model: ci(acc.model), gate: ci(acc.gate), diff: ci(acc.diff) };
}

/**
 * Score from results and gold labels. Pure. The threshold sees only tune-half
 * rows; the test half is scored with it frozen.
 */
export function score({ set, gold, decisionRows, gateRows }) {
  const prob = new Map(decisionRows.flatMap((r) => r.probabilities.map((x) => [x.pairId, x.p])));
  const gatePasses = new Map();
  for (const r of gateRows) for (const k of r.kept) gatePasses.set(k.pairId, [...(gatePasses.get(k.pairId) ?? []), k.kept]);
  const rows = set.pairs
    .filter((p) => gold.has(p.pairId))
    .map((p) => {
      const passes = gatePasses.get(p.pairId) ?? [];
      return {
        pairId: p.pairId,
        slug: p.slug,
        half: p.half,
        stratum: p.stratum,
        rated: p.rated,
        gold: gold.get(p.pairId) === 'yes',
        p: prob.get(p.pairId) ?? null,
        gate: passes[0] ?? null,
        gatePasses: passes,
      };
    });
  const usable = rows.filter((r) => typeof r.p === 'number' && typeof r.gate === 'boolean');
  const tune = usable.filter((r) => r.half === 'tune');
  const test = usable.filter((r) => r.half === 'test');
  const gateTune = metrics(tune.map((r) => ({ pred: r.gate, gold: r.gold })));
  const threshold = chooseThreshold(tune.map((r) => ({ p: r.p, gold: r.gold })), gateTune.precision);
  const scored = test.map((r) => ({ ...r, model: r.p >= threshold.t }));
  const arms = (list) => ({
    decision: metrics(list.map((r) => ({ pred: r.model, gold: r.gold }))),
    gate: metrics(list.map((r) => ({ pred: r.gate, gold: r.gold }))),
  });
  let b = 0;
  let c = 0;
  for (const r of scored) {
    const mr = r.model === r.gold;
    const gr = r.gate === r.gold;
    if (mr && !gr) b++;
    if (!mr && gr) c++;
  }
  const strata = {};
  for (const key of ['stratum', 'rated']) {
    for (const v of [...new Set(scored.map((r) => r[key]))].sort()) strata[`${key}:${v}`] = arms(scored.filter((r) => r[key] === v));
  }
  const multi = rows.filter((r) => r.gatePasses.length > 1);
  const flips = multi.filter((r) => new Set(r.gatePasses).size > 1).length;
  const f1Test = threshold.f1Best === null ? null : metrics(test.map((r) => ({ pred: r.p >= threshold.f1Best, gold: r.gold })));
  return {
    goldPairs: rows.length,
    usablePairs: usable.length,
    tunePairs: tune.length,
    testPairs: test.length,
    underpowered: rows.length < POWER_MIN_GOLD,
    threshold,
    gateTune,
    test: arms(scored),
    secondaryF1Threshold: f1Test,
    mcnemar: { decisionRightGateWrong: b, gateRightDecisionWrong: c, p: mcnemar(b, c) },
    strata,
    bootstrap: clusteredBootstrap(scored),
    gateVariation: { pairsWithRepeats: multi.length, pairsThatFlipped: flips },
  };
}

function costSummary(decisionRows, gateRows) {
  const arm = (rows, listPrice) => {
    const costs = rows.map((r) => Number(r.usage?.cost) || 0);
    const ms = rows.map((r) => r.ms).filter((x) => typeof x === 'number').sort((a, b) => a - b);
    const total = costs.reduce((s, x) => s + x, 0);
    const mean = rows.length ? total / rows.length : 0;
    return {
      calls: rows.length,
      billedUsd: round4(total),
      listPriceUsd: listPrice === null ? null : round4(listPrice),
      meanUsdPerCall: mean,
      nightlyProjectionUsd: round4(mean * NIGHTLY_CALLS),
      latencyMs: { median: quantile(ms, 0.5), p90: quantile(ms, 0.9) },
      errors: rows.filter((r) => r.error).length,
    };
  };
  return {
    decision: arm(decisionRows, null),
    gate: { ...arm(gateRows, gateRows.reduce((s, r) => s + (r.listPriceUsd || 0), 0)), unanswered: gateRows.filter((r) => !r.answered).length },
  };
}

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const ciText = (ci) => (ci ? `[${pct(ci[0])}, ${pct(ci[1])}]` : '');

export function renderReport(report) {
  const s = report.score;
  const t = s.test;
  const row = (name, m) => `| ${name} | ${m.n} | ${pct(m.accuracy)} ${ciText(m.accuracyCI)} | ${pct(m.precision)} ${ciText(m.precisionCI)} | ${pct(m.recall)} ${ciText(m.recallCI)} | ${pct(m.f1)} |`;
  const out = [
    '# Decision model vs the coverage relevance gate (offline test)',
    '',
    `Generated ${report.generatedAt}. Set: ${report.set.pairs} pairs over ${report.set.bills} bills (seed ${report.set.seed}).`,
    '',
    `Labels: gold = every judge (${report.agreement.judges.join(', ')}) gave the same yes or no. ${report.agreement.gold.gold} gold, ` +
      `${report.agreement.gold.disagree} judges disagreed, ${report.agreement.gold.unsure} had an unsure, ${report.agreement.gold.missing} missing; those are left out of every figure below.`,
    '',
    s.underpowered ? `**Underpowered: ${s.goldPairs} gold pairs, under ${POWER_MIN_GOLD}. The head-to-head below cannot reliably show a 5-point difference.**` : '',
    '',
    '## Threshold (tune half only)',
    '',
    `t = ${s.threshold.t} (${s.threshold.policyMet ? `the smallest threshold whose tune-half precision reaches the gate's ${pct(s.threshold.gatePrecision)}` : `NO threshold reached the gate's tune-half precision of ${pct(s.threshold.gatePrecision)}; this is the highest-precision one`}). ` +
      `F1-best t (secondary): ${s.threshold.f1Best}. Tune pairs ${s.tunePairs}; test pairs ${s.testPairs}.`,
    '',
    '## Test half',
    '',
    '| Arm | n | Accuracy | Precision | Recall | F1 |',
    '|---|---|---|---|---|---|',
    row('Decision model', t.decision),
    row('Gate (first pass)', t.gate),
    s.secondaryF1Threshold ? row('Decision model at the F1-best t (secondary)', s.secondaryF1Threshold) : '',
    '',
    `McNemar (exact): decision right and gate wrong ${s.mcnemar.decisionRightGateWrong}, the reverse ${s.mcnemar.gateRightDecisionWrong}, p = ${s.mcnemar.p.toFixed(4)}.`,
    s.bootstrap
      ? `Bill-clustered bootstrap (${s.bootstrap.resamples} resamples, ${s.bootstrap.clusters} bills): decision accuracy ${ciText(s.bootstrap.model)}, gate ${ciText(s.bootstrap.gate)}, difference ${ciText(s.bootstrap.diff)}.`
      : '',
    `Gate run-to-run: ${s.gateVariation.pairsThatFlipped} of ${s.gateVariation.pairsWithRepeats} repeated pairs changed answer between passes.`,
    '',
    '## By stratum (test half)',
    '',
    '| Stratum | n | Decision accuracy | Gate accuracy |',
    '|---|---|---|---|',
    ...Object.entries(s.strata).map(([k, v]) => `| ${k} | ${v.decision.n} | ${pct(v.decision.accuracy)} | ${pct(v.gate.accuracy)} |`),
    '',
    '## Cost and latency',
    '',
    `Decision arm: ${report.cost.decision.calls} calls, billed ${usd(report.cost.decision.billedUsd)}, median ${report.cost.decision.latencyMs.median?.toFixed(0) ?? 'n/a'} ms, p90 ${report.cost.decision.latencyMs.p90?.toFixed(0) ?? 'n/a'} ms, ${report.cost.decision.errors} errors; nightly projection (${NIGHTLY_CALLS} calls) ${usd(report.cost.decision.nightlyProjectionUsd)}.`,
    `Gate arm: ${report.cost.gate.calls} calls, billed ${usd(report.cost.gate.billedUsd)} (list price from tokens ${usd(report.cost.gate.listPriceUsd ?? 0)}), median ${report.cost.gate.latencyMs.median?.toFixed(0) ?? 'n/a'} ms, p90 ${report.cost.gate.latencyMs.p90?.toFixed(0) ?? 'n/a'} ms, ${report.cost.gate.errors} errors, ${report.cost.gate.unanswered} replies not complete and well-formed; nightly projection ${usd(report.cost.gate.nightlyProjectionUsd)}.`,
    '',
    '## Known weak points',
    '',
    '- Every stored-origin pair was once kept by the gate, so that stratum favours it. The swap strata are the unbiased part; read the per-stratum table.',
    '- The labels come from two model judges that read the full article where it could be fetched. They see more than the gate does (a title and a snippet), but they are still models. The owner\'s hand check measures how far they agree with him.',
    '- English only. Nothing here says anything about Spanish.',
    '- The gateway\'s billed cost and latency for the gate model are not the same as production\'s direct call.',
    '',
  ];
  return out.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

// ---- the script ----------------------------------------------------------

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1] ?? null;
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
}

const MODES = ['--build-set', '--import-labels', '--label', '--agreement', '--plan', '--probe', '--run', '--score'];

function hashDataFiles(root, names) {
  return Object.fromEntries(names.map((n) => [n, sha1(readFileSync(join(root, 'data', n)))]));
}

/**
 * @param {string[]} [argv]
 * @param {{ env?: Record<string, string|undefined>, root?: string|null, cwd?: string, fetchImpl?: typeof fetch, log?: (s: string) => void, now?: Date, stdin?: AsyncIterable<string>|null }} [opts]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), { env = process.env, root = null, cwd = process.cwd(), fetchImpl = globalThis.fetch, log = console.log, now = new Date(), stdin = null } = {}) {
  const key = env.OPENROUTER_API_KEY || '';
  const say = (s) => log(redact(s, key));
  const mode = MODES.find((m) => argv.includes(m));
  if (!mode) {
    say(`eval-decision-model: name one mode: ${MODES.join(', ')}`);
    return 2;
  }
  if (!root) {
    say('eval-decision-model: cannot find the repo root, so nothing is read or written. Run this as a file: node scripts/eval-decision-model.mjs <mode> ...');
    return 2;
  }
  const building = mode === '--build-set';
  const flag = building ? '--out' : '--set';
  const dirArg = argValue(argv, flag) ?? (building ? env.DECISION_EVAL_OUT : env.DECISION_EVAL_SET) ?? null;
  if (!dirArg) {
    say(`eval-decision-model: no folder given. Pass ${flag} <folder outside the repo> (or set ${building ? 'DECISION_EVAL_OUT' : 'DECISION_EVAL_SET'}).`);
    return 2;
  }
  const dir = resolve(cwd, dirArg);
  if (isInsideRepo(dir, root)) {
    say(`eval-decision-model: REFUSING ${dirArg}: results never go inside the repo.`);
    return 2;
  }

  if (mode === '--build-set') {
    const seed = Number(argValue(argv, '--seed') ?? DEFAULT_SEED);
    if (!Number.isSafeInteger(seed)) {
      say('eval-decision-model: --seed must be an integer.');
      return 2;
    }
    const read = (p) => JSON.parse(readFileSync(join(root, 'data', p), 'utf8'));
    const set = buildSet({ coverage: read('coverage.json'), bills: read('bills.json'), mediaBias: read('media-bias.json'), seed });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pairs.jsonl'), jsonl(set.pairs));
    const meta = {
      kind: 'decision-model-eval-set',
      createdAt: now.toISOString(),
      seed,
      target: set.target,
      want: set.want,
      shortfall: set.shortfall,
      summary: set.summary,
      sources: hashDataFiles(root, ['coverage.json', 'bills.json', 'media-bias.json']),
      note: 'Origin and stratum are metadata, never labels. No labels are in this set.',
      lists: set.lists,
      bills: set.bills,
    };
    writeFileSync(join(dir, 'set.json'), `${JSON.stringify(meta, null, 2)}\n`);
    const s = set.summary;
    say(`SET: ${s.pairs} pairs, ${s.bills} bills, ${s.uniqueUrls} unique URLs (seed ${seed}) -> ${dir}`);
    say(`  by stratum ${JSON.stringify(s.byStratum)}; by origin ${JSON.stringify(s.byOrigin)}; ${JSON.stringify(s.byRated)}`);
    say(`  pairs by half ${JSON.stringify(s.byHalf)}; bills by half ${JSON.stringify(s.billsByHalf)}; swap shortfall ${JSON.stringify(set.shortfall)}`);
    return 0;
  }

  if (!existsSync(join(dir, 'set.json'))) {
    say(`eval-decision-model: no set at ${dirArg}. Build one with --build-set first.`);
    return 2;
  }
  const set = loadSet(dir);

  if (mode === '--import-labels') {
    const file = argValue(argv, '--import-labels');
    const name = argValue(argv, '--labeller');
    if (!file || !safeName(name)) {
      say('eval-decision-model: --import-labels needs a FILE and --labeller NAME (letters, digits, - or _).');
      return 2;
    }
    if (resultsExist(dir)) {
      say('eval-decision-model: REFUSING: model results already exist in this set, so labels imported now would not be blind.');
      return 2;
    }
    const { labels, problems } = parseLabels(readLabelSource(resolve(cwd, file)), new Set(set.pairById.keys()));
    for (const p of problems.slice(0, 20)) say(`  problem: ${p}`);
    mkdirSync(join(dir, LABELLERS_DIR), { recursive: true });
    writeFileSync(join(dir, LABELLERS_DIR, `${name}.jsonl`), jsonl([...labels].map(([pairId, label]) => ({ pairId, label }))));
    say(`imported ${labels.size} label(s) for ${name} (${set.pairs.length - labels.size} pair(s) unlabelled, ${problems.length} problem(s)).`);
    return problems.length ? 1 : 0;
  }

  if (mode === '--label') {
    const name = argValue(argv, '--labeller');
    if (!safeName(name)) {
      say('eval-decision-model: --label needs --labeller NAME.');
      return 2;
    }
    const limit = argValue(argv, '--limit') ? Number(argValue(argv, '--limit')) : Infinity;
    const sample = argValue(argv, '--sample');
    const path = join(dir, LABELLERS_DIR, `${name}.jsonl`);
    const already = new Set(existsSync(path) ? readJsonl(path).map((r) => r.pairId) : []);
    let lines = stdin;
    if (!lines) {
      const { createInterface } = await import('node:readline');
      lines = createInterface({ input: process.stdin });
    }
    const got = await labelSession({ set, already, lines, write: (s) => say(s), limit, sampleSeed: sample === null ? null : Number(sample) });
    mkdirSync(join(dir, LABELLERS_DIR), { recursive: true });
    if (got.length) appendFileSync(path, jsonl(got));
    say(`${got.length} label(s) saved for ${name}.`);
    return 0;
  }

  const labellers = loadLabellers(dir);
  const judges = judgesFrom(argv, labellers);

  if (mode === '--agreement') {
    const r = agreementReport(set, labellers, judges);
    writeFileSync(join(dir, 'agreement.json'), `${JSON.stringify(r, null, 2)}\n`);
    for (const l of r.labellers) say(`${l.name}: ${l.labelled} labelled`);
    for (const p of r.pairwise) say(`${p.a} vs ${p.b}: n ${p.n}, agreement ${pct(p.agreement)}, kappa ${p.kappa === null ? 'n/a' : p.kappa.toFixed(3)}`);
    for (const p of r.vsGold) say(`${p.labeller} vs gold: n ${p.n}, agreement ${pct(p.agreement)}, kappa ${p.kappa === null ? 'n/a' : p.kappa.toFixed(3)}`);
    say(`gold (judges ${judges.join(', ') || 'none'}): ${JSON.stringify(r.gold)}`);
    return 0;
  }

  const repeat = Math.max(1, Math.min(5, Number(argValue(argv, '--repeat') ?? 1) || 1));
  const plan = planRun(set, { repeat });

  if (mode === '--plan') {
    printPlan(plan, say);
    return 0;
  }

  if (mode === '--score') {
    const rd = join(dir, RESULTS_DIR);
    if (!existsSync(join(rd, 'decision.jsonl')) || !existsSync(join(rd, 'gate.jsonl'))) {
      say('eval-decision-model: no results to score. Run --run first.');
      return 2;
    }
    const g = goldLabels(set, labellers, judges);
    const decisionRows = readJsonl(join(rd, 'decision.jsonl'));
    const gateRows = readJsonl(join(rd, 'gate.jsonl'));
    for (const [arm, rows] of [['decision', decisionRows], ['gate', gateRows]]) {
      if (!rows.some((r) => rowSucceeded(arm, r))) {
        say(`eval-decision-model: REFUSING to score: the ${arm} arm has no successful request (${rows.length} row(s), all failed). Fix the cause and run --run again.`);
        return 2;
      }
    }
    const report = {
      kind: 'decision-model-eval-report',
      generatedAt: now.toISOString(),
      set: { pairs: set.pairs.length, bills: set.lists.length, seed: set.seed },
      agreement: { judges, gold: g.counts },
      score: score({ set, gold: g.gold, decisionRows, gateRows }),
      cost: costSummary(decisionRows, gateRows),
    };
    writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(dir, 'report.md'), `${renderReport(report)}\n`);
    say(`report written: ${join(dir, 'report.md')}`);
    return 0;
  }

  // --probe and --run send requests. Every guard below runs before any send.
  if (mode === '--run') {
    const g = goldLabels(set, labellers, judges);
    if (!g.complete) {
      say(`eval-decision-model: REFUSING to run: gold labels are incomplete (${judges.length} judge(s); ${g.counts.missing} pair(s) missing a judge's label). Nothing sent.`);
      return 2;
    }
  }
  if (plan.totalUsd > COST_CEILING_USD) {
    say(`eval-decision-model: REFUSING: the estimate ${usd(plan.totalUsd)} is over the ${usd(COST_CEILING_USD)} ceiling. Nothing sent.`);
    return 2;
  }
  if (!key) {
    say('eval-decision-model: OPENROUTER_API_KEY is not set. Nothing sent. (Use --plan to see what would be sent.)');
    return 1;
  }
  const k = await checkKey({ key, fetchImpl, log: say });
  if (!k.ok) {
    say(`eval-decision-model: REFUSING: ${k.why}. Nothing else sent.`);
    return 2;
  }

  if (mode === '--probe') {
    const l = listsOf(set)[0];
    const one = l.pairs.slice(0, 1);
    const budget = { sent: 0, cap: 2 * (1 + MAX_RETRIES) };
    const dec = await send({ url: OPENROUTER.decisions, body: decisionRequest(l.bill, one), key, fetchImpl, budget });
    const chat = await send({ url: OPENROUTER.chat, body: gateRequest(l.bill, one), key, fetchImpl, budget });
    const pd = join(dir, 'probe');
    mkdirSync(pd, { recursive: true });
    writeOut(join(pd, 'decisions.json'), `${JSON.stringify({ status: dec?.status ?? null, error: dec?.error ?? null, raw: dec?.raw ?? null }, null, 2)}\n`, key);
    writeOut(join(pd, 'chat.json'), `${JSON.stringify({ status: chat?.status ?? null, error: chat?.error ?? null, raw: chat?.raw ?? null }, null, 2)}\n`, key);
    say(`probe: decisions ${dec?.status ?? dec?.error}, chat ${chat?.status ?? chat?.error}; raw shapes saved to ${pd}`);
    return 0;
  }

  const summary = await runArms({ set, key, fetchImpl, repeat, log: say, dir });
  say(
    `RUN: decision ${summary.decision.sent}/${summary.decision.cap} sent, ${usd(summary.decision.usd)}; ` +
      `gate ${summary.gate.sent}/${summary.gate.cap} sent, ${usd(summary.gate.usd)}${summary.stoppedOnCost ? '; STOPPED: billed cost passed the ceiling' : ''}.`,
  );
  say(`RESULT: decision ${summary.decision.ok} succeeded, ${summary.decision.failed} failed; gate ${summary.gate.ok} succeeded, ${summary.gate.failed} failed.`);
  const dead = ['decision', 'gate'].filter((a) => summary[a].ok === 0);
  if (dead.length) {
    say(`eval-decision-model: FAILED: no request succeeded in the ${dead.join(' and ')} arm. Do not score this run. Exit ${EXIT_ARM_FAILED}.`);
    return EXIT_ARM_FAILED;
  }
  say('Next: --score.');
  return 0;
}

if (/(^|[\\/])eval-decision-model\.mjs$/.test(process.argv[1] ?? '')) {
  // The repo root is one level above this file (scripts/), wherever the command was typed.
  main(process.argv.slice(2), { root: resolve(dirname(realpathSync(process.argv[1])), '..') }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(redact(`eval-decision-model: ${e instanceof Error ? e.message : e}`, process.env.OPENROUTER_API_KEY));
      process.exit(1);
    },
  );
}
