import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// scripts/eval-decision-model.mjs: the offline decision-model test. Every
// request here goes to a mocked fetch; nothing in this file reaches the
// network or reads a real key.
import {
  COST_CEILING_USD,
  GATE_MODEL,
  OPENROUTER,
  OPENROUTER_SLUG,
  buildSet,
  chooseThreshold,
  cohenKappa,
  gateRequest,
  EXIT_ARM_FAILED,
  goldLabels,
  halfOf,
  isInsideRepo,
  labelCard,
  listsOf,
  loadSet,
  main,
  mcnemar,
  noulProbability,
  planRun,
  redact,
  score,
  stopReasonOf,
  wilson,
} from '../scripts/eval-decision-model.mjs';
import { relevancePrompt } from '../scripts/coverage-query.mjs';

const ROOT = process.cwd();
const readData = (p: string) => JSON.parse(readFileSync(join(ROOT, 'data', p), 'utf8'));
const DATA = { coverage: readData('coverage.json'), bills: readData('bills.json'), mediaBias: readData('media-bias.json') };

const tmp = () => mkdtempSync(join(tmpdir(), 'eval-decision-'));

type Call = { url: string; method: string; headers: Record<string, string>; body: { questions: Record<string, unknown> } | null };
type Article = { title: string; url: string; source: string; snippet: string | null; publishedAt: string | null };
type Pair = { pairId: string; slug: string; half: string; origin: string; stratum: string; rated: string; storedUnder: string[]; article: Article };
type ScorePair = Pick<Pair, 'pairId' | 'slug' | 'half' | 'stratum' | 'rated'>;
const asFetch = (f: unknown) => f as typeof fetch;

/** A fetch stand-in. `limit` is what the key check reports; `echo500` makes every POST fail echoing its headers. */
function mockFetch({ limit = 2 as number | null, echo500 = false, keyReply = null as null | { status: number; body: unknown } } = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const reply = (status: number, obj: unknown) => ({ ok: status < 300, status, text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) });
    if (url === OPENROUTER.key && keyReply) return reply(keyReply.status, keyReply.body);
    if (url === OPENROUTER.key) return reply(200, { data: { limit, limit_remaining: limit } });
    if (echo500) return reply(500, `upstream said: ${JSON.stringify(call.headers)}`);
    if (url === OPENROUTER.decisions) {
      const answers: Record<string, unknown> = {};
      for (const name of Object.keys(call.body?.questions ?? {})) answers[name] = { type: 'noul', noul: Number(name.split('_')[1]) % 2 ? 0.2 : 0.9 };
      return reply(200, { answers, usage: { input_tokens: 100, output_tokens: 10, cost: 0.00001 } });
    }
    if (url === OPENROUTER.chat) {
      return reply(200, {
        choices: [{ message: { content: '0' }, finish_reason: 'stop', native_finish_reason: 'end_turn' }],
        usage: { prompt_tokens: 500, completion_tokens: 2, cost: 0.0005 },
      });
    }
    return reply(404, 'no');
  };
  return { fetchImpl, calls };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

async function buildInto(dir: string, seed = 7) {
  const logs: string[] = [];
  const code = await main(['--build-set', '--out', dir, '--seed', String(seed)], { root: ROOT, env: {}, log: (s) => logs.push(s) });
  expect(code).toBe(0);
  return logs;
}

/** Two judges who label every pair; they disagree on one. */
async function labelBoth(dir: string) {
  const set = loadSet(dir);
  for (const [name, flip] of [['judge-a', false], ['judge-b', true]] as const) {
    const lines = set.pairs.map((p: Pair, i: number) => ({ pairId: p.pairId, label: flip && i === 0 ? 'unsure' : p.origin === 'stored' ? 'yes' : 'no' }));
    const f = join(dir, `${name}.in.jsonl`);
    writeFileSync(f, lines.map((l: { pairId: string; label: string }) => JSON.stringify(l)).join('\n') + '\n');
    const code = await main(['--import-labels', f, '--labeller', name, '--set', dir], { root: ROOT, env: {}, log: () => {} });
    expect(code).toBe(0);
  }
}

test.describe('the set', () => {
  test('is deterministic for a seed, and a different seed gives a different set', () => {
    const a = buildSet({ ...DATA, seed: 11 });
    const b = buildSet({ ...DATA, seed: 11 });
    const c = buildSet({ ...DATA, seed: 12 });
    expect(JSON.stringify(a.pairs)).toBe(JSON.stringify(b.pairs));
    expect(JSON.stringify(a.lists)).toBe(JSON.stringify(b.lists));
    expect(JSON.stringify(a.pairs)).not.toBe(JSON.stringify(c.pairs));
  });

  test('a swap pair never goes to a bill that stores the same URL', () => {
    const set = buildSet({ ...DATA, seed: 3 });
    const under = new Map<string, Set<string>>();
    for (const [slug, list] of Object.entries(DATA.coverage)) {
      if (slug.startsWith('_') || !Array.isArray(list)) continue;
      for (const a of list as { url: string }[]) under.set(a.url, (under.get(a.url) ?? new Set()).add(slug));
    }
    const swaps = set.pairs.filter((p: Pair) => p.origin === 'swap');
    expect(swaps.length).toBeGreaterThan(0);
    for (const p of swaps) expect(under.get(p.article.url)?.has(p.slug)).toBe(false);
    for (const p of set.pairs.filter((x: Pair) => x.origin === 'stored')) expect(under.get(p.article.url)?.has(p.slug)).toBe(true);
  });

  test('no bill is in both halves, and the half is hash(slug) mod 2', () => {
    const set = buildSet({ ...DATA, seed: 5 });
    const halves = new Map<string, Set<string>>();
    for (const p of set.pairs) halves.set(p.slug, (halves.get(p.slug) ?? new Set()).add(p.half));
    for (const [slug, h] of halves) {
      expect(h.size).toBe(1);
      expect([...h][0]).toBe(halfOf(slug));
    }
  });

  test('lists are capped at 25 and hold no URL twice; articles are in production candidate shape', () => {
    const set = buildSet({ ...DATA, seed: 9 });
    const byId = new Map(set.pairs.map((p: Pair) => [p.pairId, p]));
    for (const l of set.lists) {
      expect(l.pairIds.length).toBeLessThanOrEqual(25);
      const urls = l.pairIds.map((id: string) => (byId.get(id) as Pair).article.url);
      expect(new Set(urls).size).toBe(urls.length);
    }
    for (const p of set.pairs) expect(Object.keys(p.article).sort()).toEqual(['publishedAt', 'snippet', 'source', 'title', 'url']);
  });
});

test.describe('the gate arm sends what production sends', () => {
  test('the prompt is relevancePrompt output and max_tokens is production\'s', () => {
    const set = buildSet({ ...DATA, seed: 4 });
    const pairById = new Map(set.pairs.map((p: Pair) => [p.pairId, p]));
    const l = listsOf({ ...set, pairById })[0];
    const body = gateRequest(l.bill, l.pairs);
    expect(body.messages).toEqual([{ role: 'user', content: relevancePrompt(l.bill, l.pairs.map((p: Pair) => p.article)) }]);
    expect(body.max_tokens).toBe(Math.max(80, 4 * l.pairs.length));
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('system');
    expect(body.model).toBe(OPENROUTER_SLUG[GATE_MODEL]);
  });

  test('stop reasons map to the vocabulary gateAnswered reads', () => {
    expect(stopReasonOf({ native_finish_reason: 'end_turn', finish_reason: 'stop' })).toBe('end_turn');
    expect(stopReasonOf({ native_finish_reason: 'max_tokens', finish_reason: 'length' })).toBe('max_tokens');
    expect(stopReasonOf({ finish_reason: 'stop' })).toBe('end_turn');
    expect(stopReasonOf({ finish_reason: 'length' })).toBe('max_tokens');
    expect(stopReasonOf({ finish_reason: 'content_filter' })).toBe('refusal');
    expect(stopReasonOf({})).toBe(null);
    expect(stopReasonOf(undefined)).toBe(null);
  });

  test('the model slug map has an entry for the nightly gate model in scripts/sync-coverage.mjs', () => {
    const src = readFileSync(join(ROOT, 'scripts/sync-coverage.mjs'), 'utf8');
    const m = src.match(/^const MODEL = '([^']+)';/m);
    expect(m?.[1]).toBe(GATE_MODEL);
    expect(OPENROUTER_SLUG[m![1] as keyof typeof OPENROUTER_SLUG]).toBeTruthy();
  });

  test('a noul answer reads its documented probability, and nothing else', () => {
    expect(noulProbability({ type: 'noul', noul: 0.96 })).toBe(0.96);
    expect(noulProbability({ type: 'noul', noul: 1.5 })).toBe(null);
    expect(noulProbability(undefined)).toBe(null);
  });
});

test.describe('spend and key guards: nothing is sent', () => {
  test('over the ceiling: zero requests of any kind', async () => {
    const dir = tmp();
    await buildInto(dir);
    await labelBoth(dir);
    // Inflate the set so the estimate passes the ceiling.
    const setJson = JSON.parse(readFileSync(join(dir, 'set.json'), 'utf8'));
    setJson.lists = Array.from({ length: 40 }, () => setJson.lists).flat();
    writeFileSync(join(dir, 'set.json'), JSON.stringify(setJson));
    expect(planRun(loadSet(dir), { repeat: 3 }).totalUsd).toBeGreaterThan(COST_CEILING_USD);
    const { fetchImpl, calls } = mockFetch();
    const logs: string[] = [];
    const code = await main(['--run', '--set', dir, '--repeat', '3'], { root: ROOT, env: { OPENROUTER_API_KEY: 'KEY-over-ceiling-1234' }, fetchImpl: asFetch(fetchImpl), log: (s) => logs.push(s) });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(logs.join('\n')).toContain('over the');
    rmSync(dir, { recursive: true, force: true });
  });

  test('no key: zero requests', async () => {
    const dir = tmp();
    await buildInto(dir);
    await labelBoth(dir);
    for (const mode of ['--run', '--probe']) {
      const { fetchImpl, calls } = mockFetch();
      const code = await main([mode, '--set', dir], { root: ROOT, env: {}, fetchImpl: asFetch(fetchImpl), log: () => {} });
      expect(code).toBe(1);
      expect(calls).toEqual([]);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('a key with no limit, or a limit above $5: only the free key check, no request to either arm', async () => {
    const dir = tmp();
    await buildInto(dir);
    await labelBoth(dir);
    for (const limit of [null, 25]) {
      const { fetchImpl, calls } = mockFetch({ limit });
      const code = await main(['--run', '--set', dir], { root: ROOT, env: { OPENROUTER_API_KEY: 'KEY-uncapped-5678' }, fetchImpl: asFetch(fetchImpl), log: () => {} });
      expect(code).toBe(2);
      expect(calls.map((c) => c.url)).toEqual([OPENROUTER.key]);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('the key check answering HTTP 500, or a malformed body: exit 2 and no model call', async () => {
    const dir = tmp();
    await buildInto(dir);
    await labelBoth(dir);
    for (const keyReply of [
      { status: 500, body: 'upstream broke' },
      { status: 200, body: 'this is not json {' },
      { status: 200, body: { data: { limit: 'five' } } },
    ]) {
      const { fetchImpl, calls } = mockFetch({ keyReply });
      const logs: string[] = [];
      const code = await main(['--run', '--set', dir], { root: ROOT, env: { OPENROUTER_API_KEY: 'KEY-keycheck-1111' }, fetchImpl: asFetch(fetchImpl), log: (s) => logs.push(s) });
      expect(code).toBe(2);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.url === OPENROUTER.key)).toBe(true);
      expect(logs.join('\n')).toContain('REFUSING');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('--probe with no key, an empty key, or a failing key check: no model call', async () => {
    const dir = tmp();
    await buildInto(dir);
    for (const env of [{}, { OPENROUTER_API_KEY: '' }]) {
      const { fetchImpl, calls } = mockFetch();
      const logs: string[] = [];
      expect(await main(['--probe', '--set', dir], { root: ROOT, env, fetchImpl: asFetch(fetchImpl), log: (s) => logs.push(s) })).toBe(1);
      expect(calls).toEqual([]);
      expect(logs.join('\n')).toContain('OPENROUTER_API_KEY is not set');
    }
    const { fetchImpl, calls } = mockFetch({ keyReply: { status: 500, body: 'no' } });
    expect(await main(['--probe', '--set', dir], { root: ROOT, env: { OPENROUTER_API_KEY: 'KEY-probe-2222' }, fetchImpl: asFetch(fetchImpl), log: () => {} })).toBe(2);
    expect(calls.every((c) => c.url === OPENROUTER.key)).toBe(true);
    expect(existsSync(join(dir, 'probe'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('incomplete gold labels: zero requests', async () => {
    const dir = tmp();
    await buildInto(dir);
    const { fetchImpl, calls } = mockFetch();
    const code = await main(['--run', '--set', dir], { root: ROOT, env: { OPENROUTER_API_KEY: 'KEY-nolabels-0000' }, fetchImpl: asFetch(fetchImpl), log: () => {} });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test('--plan sends nothing and reads no key', async () => {
    const dir = tmp();
    await buildInto(dir);
    const { fetchImpl, calls } = mockFetch();
    const logs: string[] = [];
    const code = await main(['--plan', '--set', dir, '--repeat', '3'], { root: ROOT, env: { OPENROUTER_API_KEY: 'KEY-plan-9999' }, fetchImpl: asFetch(fetchImpl), log: (s) => logs.push(s) });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(logs.join('\n')).toContain('TOTAL ESTIMATE');
    rmSync(dir, { recursive: true, force: true });
  });
});

test.describe('the key never leaves the Authorization header', () => {
  test('not in logs or files, even when every error echoes the header back', async () => {
    const dir = tmp();
    await buildInto(dir);
    await labelBoth(dir);
    const KEY = 'TESTKEY-abc123-do-not-leak';
    const { fetchImpl, calls } = mockFetch({ echo500: true });
    const logs: string[] = [];
    const code = await main(['--run', '--set', dir], { root: ROOT, env: { OPENROUTER_API_KEY: KEY }, fetchImpl: asFetch(fetchImpl), log: (s) => logs.push(s) });
    expect(code).toBe(EXIT_ARM_FAILED);
    expect(calls.some((c) => c.headers.Authorization === `Bearer ${KEY}`)).toBe(true);
    expect(logs.join('\n')).not.toContain(KEY);
    expect(logs.join('\n')).toContain('[REDACTED]');
    await main(['--probe', '--set', dir], { root: ROOT, env: { OPENROUTER_API_KEY: KEY }, fetchImpl: asFetch(fetchImpl), log: (s) => logs.push(s) });
    for (const f of filesUnder(dir)) expect(readFileSync(f, 'utf8')).not.toContain(KEY);
    expect(logs.join('\n')).not.toContain(KEY);
    rmSync(dir, { recursive: true, force: true });
  });

  test('redact removes the key and any bearer token', () => {
    expect(redact('x KEY-1234 y', 'KEY-1234')).toBe('x [REDACTED] y');
    expect(redact('{"Authorization":"Bearer abc.def"}', '')).toBe('{"Authorization":"Bearer [REDACTED]"}');
  });
});

test.describe('a run in which requests fail', () => {
  test('every request failing: exit code 3, one line with the counts per arm, and --score refuses', async () => {
    const dir = tmp();
    await buildInto(dir);
    await labelBoth(dir);
    const { fetchImpl } = mockFetch({ echo500: true });
    const logs: string[] = [];
    const code = await main(['--run', '--set', dir], { root: ROOT, env: { OPENROUTER_API_KEY: 'KEY-allfail-3333' }, fetchImpl: asFetch(fetchImpl), log: (s) => logs.push(s) });
    expect(code).toBe(EXIT_ARM_FAILED);
    const lines = logs.filter((l) => l.startsWith('RESULT:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/decision 0 succeeded, \d+ failed; gate 0 succeeded, \d+ failed\./);
    const slogs: string[] = [];
    expect(await main(['--score', '--set', dir], { root: ROOT, env: {}, log: (s) => slogs.push(s) })).toBe(2);
    expect(slogs.join('\n')).toContain('no successful request');
    rmSync(dir, { recursive: true, force: true });
  });

  test('a run where every request works exits 0 and prints the same line with zero failed', async () => {
    const dir = tmp();
    await buildInto(dir);
    await labelBoth(dir);
    const { fetchImpl } = mockFetch();
    const logs: string[] = [];
    expect(await main(['--run', '--set', dir], { root: ROOT, env: { OPENROUTER_API_KEY: 'KEY-allok-4444' }, fetchImpl: asFetch(fetchImpl), log: (s) => logs.push(s) })).toBe(0);
    expect(logs.join('\n')).toMatch(/RESULT: decision \d+ succeeded, 0 failed; gate \d+ succeeded, 0 failed\./);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a partly failed run keeps exit 0 and reports both counts; --score then works', async () => {
    const dir = tmp();
    await buildInto(dir);
    await labelBoth(dir);
    const base = mockFetch();
    let n = 0;
    const fetchImpl = async (url: string, init: never) => {
      if (url !== OPENROUTER.key && ++n % 5 === 0) return { ok: false, status: 400, text: async () => 'bad' };
      return (base.fetchImpl as (u: string, i: never) => Promise<unknown>)(url, init);
    };
    const logs: string[] = [];
    expect(await main(['--run', '--set', dir], { root: ROOT, env: { OPENROUTER_API_KEY: 'KEY-partial-5555' }, fetchImpl: asFetch(fetchImpl), log: (s) => logs.push(s) })).toBe(0);
    expect(logs.join('\n')).toMatch(/RESULT: decision [1-9]\d* succeeded, [1-9]\d* failed; gate [1-9]\d* succeeded, [1-9]\d* failed\./);
    expect(await main(['--score', '--set', dir], { root: ROOT, env: {}, log: () => {} })).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

test.describe('where the set goes is always given, and never inside the repo', () => {
  test('no folder given: exit 2 and a message that names the flag, for every mode', async () => {
    for (const [argv, flag] of [
      [['--build-set'], '--out'],
      [['--plan'], '--set'],
      [['--run'], '--set'],
      [['--probe'], '--set'],
      [['--score'], '--set'],
    ] as const) {
      const logs: string[] = [];
      expect(await main([...argv], { root: ROOT, env: {}, log: (s) => logs.push(s) })).toBe(2);
      expect(logs.join('\n')).toContain(`Pass ${flag} <folder outside the repo>`);
    }
  });

  test('DECISION_EVAL_SET and DECISION_EVAL_OUT stand in for the flags', async () => {
    const dir = tmp();
    const logs: string[] = [];
    expect(await main(['--build-set', '--seed', '7'], { root: ROOT, env: { DECISION_EVAL_OUT: dir }, log: (s) => logs.push(s) })).toBe(0);
    expect(existsSync(join(dir, 'set.json'))).toBe(true);
    expect(await main(['--plan'], { root: ROOT, env: { DECISION_EVAL_SET: dir }, log: (s) => logs.push(s) })).toBe(0);
    expect(logs.join('\n')).toContain('TOTAL ESTIMATE');
    rmSync(dir, { recursive: true, force: true });
  });

  test('the refusal is the same from another working directory (the repo root comes from the script location)', () => {
    const script = join(ROOT, 'scripts', 'eval-decision-model.mjs');
    const env = { ...process.env, OPENROUTER_API_KEY: '', DECISION_EVAL_SET: '', DECISION_EVAL_OUT: '' };
    for (const cwd of [join(ROOT, 'scripts'), tmpdir()]) {
      for (const target of [join(ROOT, 'zz-eval-out'), join(ROOT, 'data', 'x')]) {
        const r = spawnSync(process.execPath, [script, '--build-set', '--out', target], { cwd, env, encoding: 'utf8' });
        expect(r.status).toBe(2);
        expect(r.stdout).toContain('REFUSING');
      }
    }
    // A relative path typed inside the repo is refused too, from scripts/.
    const rel = spawnSync(process.execPath, [script, '--build-set', '--out', './zz-eval-out'], { cwd: join(ROOT, 'scripts'), env, encoding: 'utf8' });
    expect(rel.status).toBe(2);
    expect(existsSync(join(ROOT, 'zz-eval-out'))).toBe(false);
    expect(existsSync(join(ROOT, 'scripts', 'zz-eval-out'))).toBe(false);
    // Outside the repo, from scripts/, the same command works and writes only there.
    const out = tmp();
    const ok = spawnSync(process.execPath, [script, '--build-set', '--out', out], { cwd: join(ROOT, 'scripts'), env, encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(existsSync(join(out, 'set.json'))).toBe(true);
    rmSync(out, { recursive: true, force: true });
  });
});

test.describe('results never go in the repo, and data/ is never written', () => {
  test('--out or --set inside the repo is refused and nothing is written', async () => {
    for (const argv of [
      ['--build-set', '--out', 'eval-out'],
      ['--build-set', '--out', join(ROOT, 'data', 'x')],
      ['--plan', '--set', '.'],
      ['--score', '--set', 'tests'],
    ]) {
      const logs: string[] = [];
      expect(await main(argv, { root: ROOT, env: {}, log: (s) => logs.push(s) })).toBe(2);
      expect(logs.join('\n')).toContain('REFUSING');
    }
    expect(existsSync(join(ROOT, 'eval-out'))).toBe(false);
    expect(isInsideRepo('../elsewhere', ROOT)).toBe(false);
    expect(isInsideRepo('scripts', ROOT)).toBe(true);
  });

  test('data/ is byte-identical after a full mocked run: build, labels, run, agreement, score', async () => {
    const hashAll = () =>
      Object.fromEntries(
        readdirSync(join(ROOT, 'data'))
          .sort()
          .map((f) => [f, createHash('sha256').update(readFileSync(join(ROOT, 'data', f))).digest('hex')]),
      );
    const before = hashAll();
    const dir = tmp();
    await buildInto(dir);
    await labelBoth(dir);
    const { fetchImpl } = mockFetch();
    const env = { OPENROUTER_API_KEY: 'KEY-full-run-4321' };
    expect(await main(['--run', '--set', dir, '--repeat', '2'], { root: ROOT, env, fetchImpl: asFetch(fetchImpl), log: () => {} })).toBe(0);
    expect(await main(['--agreement', '--set', dir], { root: ROOT, env, log: () => {} })).toBe(0);
    expect(await main(['--score', '--set', dir], { root: ROOT, env, log: () => {} })).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    expect(report.score.goldPairs).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'report.md'))).toBe(true);
    expect(hashAll()).toEqual(before);
    rmSync(dir, { recursive: true, force: true });
  });
});

test.describe('labels', () => {
  test('import refuses once model results exist in the set', async () => {
    const dir = tmp();
    await buildInto(dir);
    mkdirSync(join(dir, 'results'), { recursive: true });
    writeFileSync(join(dir, 'results', 'decision.jsonl'), '');
    const f = join(dir, 'in.jsonl');
    writeFileSync(f, '');
    const logs: string[] = [];
    expect(await main(['--import-labels', f, '--labeller', 'judge-a', '--set', dir], { root: ROOT, env: {}, log: (s) => logs.push(s) })).toBe(2);
    expect(logs.join('\n')).toContain('not be blind');
    expect(existsSync(join(dir, 'labellers', 'judge-a.jsonl'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('gold needs every judge, the same answer, and no unsure', () => {
    const set = { pairs: [{ pairId: 'a' }, { pairId: 'b' }, { pairId: 'c' }, { pairId: 'd' }] };
    const labellers = new Map([
      ['j1', new Map([['a', 'yes'], ['b', 'no'], ['c', 'unsure'], ['d', 'yes']])],
      ['j2', new Map([['a', 'yes'], ['b', 'yes'], ['c', 'no']])],
    ]);
    const g = goldLabels(set, labellers, ['j1', 'j2']);
    expect([...g.gold]).toEqual([['a', 'yes']]);
    expect(g.counts).toMatchObject({ gold: 1, disagree: 1, unsure: 1, missing: 1 });
    expect(g.complete).toBe(false);
    expect(goldLabels(set, labellers, ['j1']).complete).toBe(false);
  });

  test("Cohen's kappa: perfect agreement is 1, chance-level is near 0", () => {
    const a = new Map([['1', 'yes'], ['2', 'no'], ['3', 'yes'], ['4', 'no']]);
    expect(cohenKappa(a, a).kappa).toBe(1);
    const b = new Map([['1', 'yes'], ['2', 'yes'], ['3', 'no'], ['4', 'no']]);
    expect(cohenKappa(a, b).kappa).toBeCloseTo(0, 5);
  });

  test('the labelling card shows neither origin nor stratum', () => {
    const set = buildSet({ ...DATA, seed: 2 });
    const p = set.pairs.find((x: Pair) => x.origin === 'swap');
    const card = labelCard(p, set.bills[p.slug], 0, 1);
    expect(card).not.toMatch(/swap|stored|stratum|origin/i);
    expect(card).toContain(p.article.title);
  });
});

test.describe('scoring', () => {
  const mkSet = () => {
    const pairs: ScorePair[] = [];
    for (let b = 0; b < 40; b++) {
      const slug = `hr-${b}-119`;
      for (let i = 0; i < 6; i++) pairs.push({ pairId: `${slug}-${i}`, slug, half: halfOf(slug), stratum: i < 3 ? 'stored' : 'hard-swap', rated: 'rated' });
    }
    return pairs;
  };

  test('the threshold does not move when test-half labels change', () => {
    const pairs = mkSet();
    const prob = (p: ScorePair) => (p.stratum === 'stored' ? 0.6 + (p.pairId.length % 4) / 10 : 0.1 + (p.pairId.length % 5) / 10);
    const decisionRows = [{ probabilities: pairs.map((p) => ({ pairId: p.pairId, p: prob(p) })) }];
    const gateRows = [{ kept: pairs.map((p) => ({ pairId: p.pairId, kept: p.stratum === 'stored' })) }];
    const goldA = new Map(pairs.map((p) => [p.pairId, p.stratum === 'stored' ? 'yes' : 'no']));
    const goldB = new Map(pairs.map((p) => [p.pairId, p.half === 'test' ? (goldA.get(p.pairId) === 'yes' ? 'no' : 'yes') : goldA.get(p.pairId)!]));
    const a = score({ set: { pairs }, gold: goldA, decisionRows, gateRows });
    const b = score({ set: { pairs }, gold: goldB, decisionRows, gateRows });
    expect(a.threshold).toEqual(b.threshold);
    expect(a.test.decision.accuracy).not.toBe(b.test.decision.accuracy);
    expect(a.tunePairs).toBeGreaterThan(0);
    expect(a.testPairs).toBeGreaterThan(0);
  });

  test('the policy picks the smallest threshold reaching the gate\'s precision', () => {
    const rows = [
      { p: 0.9, gold: true },
      { p: 0.8, gold: true },
      { p: 0.7, gold: false },
      { p: 0.6, gold: true },
      { p: 0.2, gold: false },
    ];
    // precision at 0.6 is 3/4, at 0.8 is 1.
    expect(chooseThreshold(rows, 0.75)).toMatchObject({ t: 0.6, policyMet: true });
    expect(chooseThreshold(rows, 0.9)).toMatchObject({ t: 0.8, policyMet: true });
    expect(chooseThreshold(rows, 1.1).policyMet).toBe(false);
  });

  test('Wilson and exact McNemar give the textbook figures', () => {
    const w = wilson(90, 100)!;
    expect(w[0]).toBeCloseTo(0.8256, 3);
    expect(w[1]).toBeCloseTo(0.9448, 3);
    expect(mcnemar(0, 0)).toBe(1);
    expect(mcnemar(10, 10)).toBeCloseTo(1, 5);
    expect(mcnemar(0, 6)).toBeCloseTo(0.03125, 6);
  });
});
