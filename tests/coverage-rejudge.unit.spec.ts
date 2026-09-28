import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// scripts/coverage-rejudge.mjs: the Big Questions coverage dry run. Every
// request here goes to a mocked client; nothing in this file reaches the
// network or reads a key.
import {
  COST_CEILING_USD,
  MODEL,
  PRICE,
  costUsd,
  isInsideData,
  liveVehicleBills,
  main,
  maxTokensFor,
  parseVerdicts,
  planRejudge,
  rejudgePrompt,
  runRejudge,
} from '../scripts/coverage-rejudge.mjs';
import { MODEL_PRICE_PER_MTOK } from '../lib/pipeline-health.mjs';

const bill = (type: string, number: number, extra: Record<string, unknown> = {}) => ({
  bill_type: type,
  bill_number: number,
  congress_number: 119,
  title: `${type} ${number} title`,
  ai_headline: `${type} ${number} headline`,
  introduced_date: '2026-01-05',
  last_action_date: '2026-09-01',
  last_action_text: 'Passed Senate.',
  status: 'passed_senate',
  ...extra,
});

const article = (n: number) => ({
  title: `Story ${n}`,
  url: `https://example.com/${n}`,
  source: 'example.com',
  snippet: `Snippet ${n}`,
  publishedAt: '2026-09-10',
  rated: false,
});

const MOMENTS = {
  'q-one': {
    name: { en: 'Question one', es: 'Pregunta uno' },
    status: 'live',
    vehicles: [{ slug: 'hr-1-119' }, { slug: 'sjres-2-119' }, { slug: 'PN-3-119', kind: 'nomination' }],
  },
  'q-two': { name: { en: 'Question two', es: 'Pregunta dos' }, status: 'live', vehicles: [{ slug: 'hr-1-119' }, { slug: 's-4-119' }] },
  'q-old': { name: { en: 'Retired', es: 'Retirada' }, status: 'retired', vehicles: [{ slug: 'hr-9-119' }] },
};
const BILLS = [bill('hr', 1), bill('sjres', 2), bill('s', 4), bill('hr', 9)];
const COVERAGE = {
  'hr-1-119': [article(0), article(1), article(2)],
  'sjres-2-119': [article(3)],
  // s-4-119 has none stored
  'hr-9-119': [article(4)],
  _checkedAt: { 'hr-1-119': '2026-09-27' },
  _note: 'fixture',
};

type Reply = { text: string; stop_reason?: string };
function mockClient(replies: Reply[] | ((params: { messages: { content: string }[] }) => Reply)) {
  const calls: { model: string; max_tokens: number; messages: { content: string }[] }[] = [];
  let i = 0;
  const client = {
    messages: {
      create: async (params: { model: string; max_tokens: number; messages: { content: string }[] }) => {
        calls.push(params);
        const r = typeof replies === 'function' ? replies(params) : replies[i++];
        return {
          content: [{ type: 'text', text: r.text }],
          stop_reason: r.stop_reason ?? 'end_turn',
          usage: { input_tokens: 1000, output_tokens: 50 },
        };
      },
    },
  };
  return { client, calls };
}

test.describe('the model and its price come from what the repo already runs', () => {
  test('MODEL is the nightly relevance gate model in scripts/sync-coverage.mjs', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/sync-coverage.mjs'), 'utf8');
    const m = src.match(/^const MODEL = '([^']+)';/m);
    expect(m?.[1]).toBe(MODEL);
  });

  test('PRICE is the Haiku 4.5 row of the repo price table', () => {
    expect(PRICE).toEqual(MODEL_PRICE_PER_MTOK['claude-haiku-4-5']);
    expect(costUsd(1_000_000, 1_000_000)).toBe(PRICE.input + PRICE.output);
  });
});

test.describe('liveVehicleBills', () => {
  test('live questions only, bill vehicles only, each slug once per question', () => {
    expect(liveVehicleBills(MOMENTS)).toEqual([
      { id: 'q-one', name: 'Question one', slugs: ['hr-1-119', 'sjres-2-119'] },
      { id: 'q-two', name: 'Question two', slugs: ['hr-1-119', 's-4-119'] },
    ]);
  });

  test('a malformed file lists nothing rather than throwing', () => {
    expect(liveVehicleBills(null)).toEqual([]);
    expect(liveVehicleBills({ _meta: { status: 'live' }, x: { status: 'live' } })).toEqual([{ id: 'x', name: 'x', slugs: [] }]);
  });
});

test.describe('parseVerdicts', () => {
  test('reads one verdict per article, with the other measure named', () => {
    const r = parseVerdicts('0: this\n1: other: H.R. 5\n2: unrelated', 3, { stopReason: 'end_turn' });
    expect(r.complete).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.verdicts).toEqual([
      { verdict: 'this', measure: null },
      { verdict: 'other', measure: 'H.R. 5' },
      { verdict: 'unrelated', measure: null },
    ]);
  });

  test('tolerates case, "." or ")" after the number, a dash before the name, and an unnamed measure', () => {
    const r = parseVerdicts('0. THIS\n1) Other — "S.J. Res. 12"\n2: other: unnamed\n3: other', 4, { stopReason: 'end_turn' });
    expect(r.complete).toBe(true);
    expect(r.verdicts.map((v) => v?.verdict)).toEqual(['this', 'other', 'other', 'other']);
    expect(r.verdicts.map((v) => v?.measure)).toEqual([null, 'S.J. Res. 12', null, null]);
  });

  test('a reply that did not finish gives no verdict at all', () => {
    for (const stopReason of ['max_tokens', 'refusal', undefined, null]) {
      const r = parseVerdicts('0: this\n1: unrelated', 2, { stopReason });
      expect(r.complete).toBe(false);
      expect(r.verdicts).toEqual([null, null]);
      expect(r.problems[0]).toContain('did not finish');
    }
  });

  test('prose after a verdict word without a separator is unreadable, not a verdict', () => {
    const r = parseVerdicts('0: this is not about the bill\n1: unrelated', 2, { stopReason: 'end_turn' });
    expect(r.verdicts).toEqual([null, { verdict: 'unrelated', measure: null }]);
    expect(r.complete).toBe(false);
    expect(r.problems.join(' | ')).toContain('unreadable line');
    expect(r.problems.join(' | ')).toContain('article 0 got no line');
  });

  test('a missing, doubled or out-of-range line leaves that article without a verdict', () => {
    const r = parseVerdicts('0: this\n0: unrelated\n2: other: H.R. 7\n5: this\n03: this', 3, { stopReason: 'end_turn' });
    expect(r.verdicts).toEqual([null, null, { verdict: 'other', measure: 'H.R. 7' }]);
    expect(r.complete).toBe(false);
    const all = r.problems.join(' | ');
    expect(all).toContain('article 0 got more than one line');
    expect(all).toContain('article 1 got no line');
    expect(all).toContain('a line for article 5');
    expect(all).toContain('a line for article 03');
  });

  test('an empty reply is n articles with no verdict', () => {
    const r = parseVerdicts('', 2, { stopReason: 'end_turn' });
    expect(r.verdicts).toEqual([null, null]);
    expect(r.problems).toEqual(['article 0 got no line', 'article 1 got no line']);
  });
});

test.describe('planRejudge', () => {
  test('one request per vehicle bill with stored articles; the cap is the number of vehicle bills', () => {
    const plan = planRejudge({ moments: MOMENTS, coverage: COVERAGE, bills: BILLS });
    expect(plan.bills.map((b) => b.slug)).toEqual(['hr-1-119', 'sjres-2-119', 's-4-119']);
    expect(plan.requestCap).toBe(3);
    expect(plan.requests).toBe(2);
    expect(plan.articles).toBe(4);
    expect(plan.bills.find((b) => b.slug === 'hr-1-119')?.questions).toEqual(['q-one', 'q-two']);
    expect(plan.bills.find((b) => b.slug === 's-4-119')?.skip).toBe('no stored articles, nothing sent');
    // the retired question's bill is never planned
    expect(plan.bills.some((b) => b.slug === 'hr-9-119')).toBe(false);
  });

  test('the estimate is priced from the repo price table and bounded by max_tokens', () => {
    const plan = planRejudge({ moments: MOMENTS, coverage: COVERAGE, bills: BILLS });
    expect(plan.estimate.outputTokens).toBe(maxTokensFor(3) + maxTokensFor(1));
    expect(plan.estimate.usd).toBeCloseTo(costUsd(plan.estimate.inputTokens, plan.estimate.outputTokens), 10);
    expect(plan.estimate.usd).toBeLessThan(COST_CEILING_USD);
  });

  test('a vehicle missing from the corpus is listed and sends nothing', () => {
    const plan = planRejudge({ moments: MOMENTS, coverage: COVERAGE, bills: BILLS.filter((b) => b.bill_type !== 'sjres') });
    expect(plan.bills.find((b) => b.slug === 'sjres-2-119')?.skip).toBe('not in data/bills.json, nothing sent');
    expect(plan.requests).toBe(1);
  });

  test('the prompt shows every stored article, numbered, with its date, and says which verdict wins on overlap', () => {
    const p = rejudgePrompt(bill('sjres', 2), [article(0), { ...article(1), publishedAt: null }]);
    expect(p).toContain('S.J. Res. 2 — sjres 2 headline');
    expect(p).toContain('0. [2026-09-10] Story 0 — Snippet 0 (example.com)');
    expect(p).toContain('1. [undated] Story 1');
    expect(p).toContain('answer other, even if that measure is on the same subject');
  });
});

test.describe('runRejudge', () => {
  test('sends one request per planned bill to the gate model, and reads the verdicts', async () => {
    const plan = planRejudge({ moments: MOMENTS, coverage: COVERAGE, bills: BILLS });
    const { client, calls } = mockClient([{ text: '0: this\n1: other: S. 8\n2: unrelated' }, { text: '0: this' }]);
    const run = await runRejudge({ plan, client });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.model === MODEL)).toBe(true);
    expect(calls[0].max_tokens).toBe(maxTokensFor(3));
    expect(run.sent).toBe(2);
    expect(run.stoppedAtCap).toBe(false);
    expect(run.results.get('hr-1-119')?.verdicts.map((v) => v?.verdict)).toEqual(['this', 'other', 'unrelated']);
    expect(run.usage).toEqual({ inputTokens: 2000, outputTokens: 100, usd: costUsd(2000, 100) });
  });

  test('never sends more than the cap, and a non-number cap falls back to one per vehicle bill', async () => {
    const plan = planRejudge({ moments: MOMENTS, coverage: COVERAGE, bills: BILLS });
    const one = mockClient(() => ({ text: '0: this' }));
    const capped = await runRejudge({ plan, client: one.client, maxRequests: 1 });
    expect(one.calls).toHaveLength(1);
    expect(capped.stoppedAtCap).toBe(true);
    expect(capped.results.get('sjres-2-119')?.error).toBe('not sent: the 1-request cap was reached');

    const wide = mockClient(() => ({ text: '0: this' }));
    const nan = await runRejudge({ plan, client: wide.client, maxRequests: Number.NaN });
    expect(nan.cap).toBe(plan.requestCap);
    expect(wide.calls.length).toBeLessThanOrEqual(plan.requestCap);

    const huge = mockClient(() => ({ text: '0: this' }));
    const over = await runRejudge({ plan, client: huge.client, maxRequests: 1_000 });
    expect(over.cap).toBe(plan.requestCap);
  });

  test('a failed request is recorded, and the run goes on', async () => {
    const plan = planRejudge({ moments: MOMENTS, coverage: COVERAGE, bills: BILLS });
    let n = 0;
    const client = {
      messages: {
        create: async () => {
          if (n++ === 0) throw new Error('overloaded');
          return { content: [{ type: 'text', text: '0: unrelated' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } };
        },
      },
    };
    const run = await runRejudge({ plan, client });
    expect(run.results.get('hr-1-119')?.error).toBe('request failed: overloaded');
    expect(run.results.get('hr-1-119')?.verdicts).toEqual([null, null, null]);
    expect(run.results.get('sjres-2-119')?.verdicts).toEqual([{ verdict: 'unrelated', measure: null }]);
  });
});

/* THE NO-WRITE GUARANTEE. The script runs against a temporary copy of data/
   with a mocked client; every file under data/ must be byte-identical after,
   and the only new files are the two report files in --out. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'coverage-rejudge-'));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data/moments.json'), JSON.stringify(MOMENTS));
  writeFileSync(join(root, 'data/coverage.json'), JSON.stringify(COVERAGE));
  writeFileSync(join(root, 'data/bills.json'), JSON.stringify(BILLS));
  return root;
}

test.describe('main writes nothing to data/', () => {
  test('a full run leaves data/ byte-identical and writes only the report', async () => {
    const root = fixtureRoot();
    try {
      const before = snapshot(join(root, 'data'));
      const { client, calls } = mockClient([{ text: '0: this\n1: other: S. 8\n2: unrelated' }, { text: '0: other' }]);
      const logs: string[] = [];
      const code = await main(['--out', 'report-out'], { env: {}, root, client, log: (s: string) => logs.push(s), now: new Date('2026-09-28T12:00:00Z') });
      expect(code).toBe(0);
      expect(calls).toHaveLength(2);
      expect(snapshot(join(root, 'data'))).toEqual(before);
      expect(readdirSync(root).sort()).toEqual(['data', 'report-out']);
      expect(readdirSync(join(root, 'report-out')).sort()).toEqual(['report.json', 'report.md']);

      const report = JSON.parse(readFileSync(join(root, 'report-out/report.json'), 'utf8'));
      expect(report.dryRun).toBe(true);
      expect(report.totals).toEqual({ questions: 2, bills: 3, articles: 4, this: 1, other: 2, unrelated: 1, noVerdict: 0 });
      expect(report.requests).toEqual({ sent: 2, cap: 3, stoppedAtCap: false });
      expect(report.bills.find((b: { slug: string }) => b.slug === 'hr-1-119').articles[1]).toMatchObject({ verdict: 'other', measure: 'S. 8', url: 'https://example.com/1' });

      const md = readFileSync(join(root, 'report-out/report.md'), 'utf8');
      expect(md).toContain('Nothing in data/ was changed, nothing was deleted, nothing was committed.');
      expect(md).toContain('written by AI');
      expect(md).toContain('## Question two');
      expect(md).toContain('No stored articles, nothing sent.');
      expect(logs.at(-1)).toContain('Nothing in data/ was written.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an --out inside data/ is refused before anything is read, sent or written', async () => {
    const root = fixtureRoot();
    try {
      const before = snapshot(join(root, 'data'));
      for (const out of ['data', 'data/report', './data/x/../y']) {
        const { client, calls } = mockClient(() => ({ text: '0: this' }));
        const code = await main(['--out', out], { env: {}, root, client, log: () => {} });
        expect(code).toBe(2);
        expect(calls).toHaveLength(0);
      }
      expect(snapshot(join(root, 'data'))).toEqual(before);
      expect(isInsideData('data-reports', root)).toBe(false);
      expect(isInsideData('../data', root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('with no key and no client it sends nothing and writes nothing; --plan the same', async () => {
    const root = fixtureRoot();
    try {
      const before = snapshot(join(root, 'data'));
      expect(await main([], { env: {}, root, log: () => {} })).toBe(1);
      expect(await main(['--plan'], { env: { ANTHROPIC_API_KEY: 'unused' }, root, log: () => {} })).toBe(0);
      expect(snapshot(join(root, 'data'))).toEqual(before);
      expect(existsSync(join(root, 'coverage-rejudge-report'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test.describe('the workflow', () => {
  const wf = readFileSync(join(process.cwd(), '.github/workflows/coverage-rejudge.yml'), 'utf8');
  const code = wf
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

  test('is started by hand only', () => {
    const on = code.match(/^on:\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? '';
    expect(on.trim()).toBe('workflow_dispatch:');
    expect(code).not.toMatch(/schedule:|push:|pull_request/);
  });

  test('cannot commit: read-only token, no git write command, and a data/ check at the end', () => {
    expect(code).toMatch(/^permissions:\n\s+contents: read\n/m);
    expect(code).not.toMatch(/contents: write|git (commit|push|add)/);
    expect(code).toContain('git diff --exit-code -- data/');
    expect(code).toContain('ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}');
  });
});
