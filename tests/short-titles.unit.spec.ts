import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  planShortTitleReads,
  serializeShortTitles,
  SHORT_TITLES_MAX_PER_NIGHT,
  verifyShortTitles,
} from '../lib/short-titles.mjs';

/*
 * The nightly read of the record's short titles (scripts/sync-short-titles.mjs,
 * data/short-titles.json): which bills it reads, the file it writes, and the
 * gate scripts/verify-sync.mjs runs before the commit (hard rule 11).
 */

const bill = (type: string, n: number, last: string | null, urgency = 0) => ({
  bill_type: type,
  bill_number: n,
  congress_number: 119,
  last_action_date: last,
  urgency_score: urgency,
});

test('plan: never-read bills first, most urgent first, then bills whose last action moved; never past the cap', () => {
  const bills = [bill('hr', 1, '2026-01-01', 0.2), bill('s', 5, '2026-02-01', 0.9), bill('hr', 4, '2026-03-01', 0.5), bill('hr', 9, '2026-03-02', 0.1)];
  const file = {
    'hr-4-119': { titles: ['Rescissions Act of 2025'], as_of: '2026-02-15' }, // moved since
    'hr-9-119': { titles: [], as_of: '2026-03-02' }, // unchanged: not read again
  };
  const plan = planShortTitleReads({ bills, file, cap: 10 });
  expect(plan.run).toEqual(['s-5-119', 'hr-1-119', 'hr-4-119']);
  expect(plan).toMatchObject({ neverRead: 2, stale: 1, deferred: 0 });
  const capped = planShortTitleReads({ bills, file, cap: 2 });
  expect(capped.run).toEqual(['s-5-119', 'hr-1-119']);
  expect(capped.deferred).toBe(1);
  expect(planShortTitleReads({ bills, file, cap: Number.NaN }).run).toHaveLength(3);
  expect(SHORT_TITLES_MAX_PER_NIGHT).toBe(500);
});

test('the file: one line per bill, sorted, bills the corpus no longer holds dropped', () => {
  const bills = [bill('s', 5, null), bill('hr', 4, null)];
  const text = serializeShortTitles(
    { 's-5-119': { titles: ['Laken Riley Act'], as_of: '2025-01-29' }, 'hr-4-119': { titles: [], as_of: null }, 'hr-77-119': { titles: ['Gone Act'], as_of: null } },
    bills,
  );
  expect(text).toBe('{\n"hr-4-119":{"titles":[],"as_of":null},\n"s-5-119":{"titles":["Laken Riley Act"],"as_of":"2025-01-29"}\n}\n');
  expect(JSON.parse(text)).toEqual({ 'hr-4-119': { titles: [], as_of: null }, 's-5-119': { titles: ['Laken Riley Act'], as_of: '2025-01-29' } });
  expect(serializeShortTitles({}, bills)).toBe('{}\n');
});

test('the gate refuses every kind of damage it names, and passes a good file', () => {
  const bills = [bill('s', 5, null), bill('hr', 4, null)];
  const good = { 's-5-119': { titles: ['Laken Riley Act'], as_of: '2025-01-29' }, 'hr-4-119': { titles: [], as_of: null } };
  expect(verifyShortTitles({ data: good, bills }).failures).toEqual([]);
  const fails = (data: unknown, before: unknown = null) => verifyShortTitles({ data, bills, before }).failures;
  expect(fails([])).toHaveLength(1);
  expect(fails({ ...good, 'laken-riley-act': { titles: [], as_of: null } }).join()).toContain('not a bill slug');
  expect(fails({ ...good, 's-6-119': { titles: [], as_of: null } }).join()).toContain('not in data/bills.json');
  expect(fails({ ...good, 's-5-119': { titles: ['A'], as_of: null, extra: 1 } }).join()).toContain('expected [as_of,titles]');
  expect(fails({ ...good, 's-5-119': { titles: [''], as_of: null } }).join()).toContain('empty');
  expect(fails({ ...good, 's-5-119': { titles: ['x'.repeat(401)], as_of: null } }).join()).toContain('over 400');
  expect(fails({ ...good, 's-5-119': { titles: ['A\tB'], as_of: null } }).join()).toContain('control');
  expect(fails({ ...good, 's-5-119': { titles: ['A', 'A'], as_of: null } }).join()).toContain('repeats');
  expect(fails({ ...good, 's-5-119': { titles: ['B', 'A'], as_of: null } }).join()).toContain('code-point order');
  expect(fails({ ...good, 's-5-119': { titles: [], as_of: '2025-1-1' } }).join()).toContain('as_of');
  expect(fails({ ...good, 's-5-119': { titles: 'A', as_of: null } }).join()).toContain('not an array');
  // Against the committed file: a bill never loses all of its titles...
  expect(fails({ ...good, 's-5-119': { titles: [], as_of: null } }, good).join()).toContain('now has none');
  // ...and the titled bills never fall by more than 10% overnight.
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`hr-${i + 1}-119`, { titles: [`Act ${i}`], as_of: null }]));
  const manyBills = Array.from({ length: 30 }, (_, i) => bill('hr', i + 1, null));
  const shrunk = Object.fromEntries(Object.entries(many).slice(0, 20));
  expect(verifyShortTitles({ data: shrunk, bills: manyBills, before: many }).failures.join()).toContain('fell 30 -> 20');
});

test('the nightly runs the gate before it writes, and verify-sync runs it again before the commit', () => {
  const sync = readFileSync(join(process.cwd(), 'scripts/sync-short-titles.mjs'), 'utf8');
  expect(sync.indexOf('verifyShortTitles(')).toBeGreaterThan(0);
  expect(sync.indexOf('verifyShortTitles(')).toBeLessThan(sync.indexOf('writeFileSync(OUT'));
  const verify = readFileSync(join(process.cwd(), 'scripts/verify-sync.mjs'), 'utf8');
  expect(verify).toContain('verifyShortTitles({ data: shortTitles');
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/sync-bills.yml'), 'utf8');
  const step = workflow.indexOf('run: node scripts/sync-short-titles.mjs');
  expect(step).toBeGreaterThan(workflow.indexOf('run: node scripts/sync-bills.mjs'));
  expect(step).toBeLessThan(workflow.indexOf('run: node scripts/verify-sync.mjs'));
  // The step carries the Congress.gov key and nothing that can spend money.
  const block = workflow.slice(workflow.lastIndexOf('- name:', step), step);
  expect(block).toContain('CONGRESS_API_KEY');
  expect(block).not.toMatch(/ANTHROPIC|NEWS_API|BLOB/);
});
