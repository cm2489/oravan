import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../messages/en.json';
import es from '../messages/es.json';
// The same module scripts/check-reader-questions.mjs runs in CI.
/* eslint-disable @typescript-eslint/no-explicit-any -- mutation fixtures edit arbitrary JSON */
import { checkReaderQuestions, digitRuns, lintAnswerText } from '../lib/reader-questions-gate.mjs';

/*
 * READER QUESTIONS (owner, 2026-11-22: "Yes, and put a first version on the
 * funding question before Dec 9"; described to him as "One question, written
 * once and dated, checked by an independent reviewer, no nightly rewrite").
 * The committed file passes the gate, and the gate catches each fault it
 * exists for.
 */

const read = (p: string) => JSON.parse(readFileSync(join(process.cwd(), p), 'utf8'));
const FILE = read('data/reader-questions.json');
const BANK = read('data/reader-questions-bank.json');
const MOMENTS = read('data/moments.json');
const MID = 'government-funding-deadline';
const clone = () => JSON.parse(JSON.stringify(FILE));

test.describe('the committed answers', () => {
  test('pass the gate', () => {
    expect(checkReaderQuestions(FILE, BANK, MOMENTS).violations).toEqual([]);
  });

  test('cover the funding question only, written once, dated, never rewritten nightly', () => {
    expect(Object.keys(FILE.questions)).toEqual([MID]);
    const e = FILE.questions[MID];
    expect(e.rewritten_nightly).toBe(false);
    expect(e.written).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(e.model).toBeTruthy();
    expect(e.picks.length).toBeGreaterThanOrEqual(5);
    expect(e.picks.length).toBeLessThanOrEqual(8);
  });

  test('every question is the bank’s own text, in both languages', () => {
    const bank = new Map(BANK.questions.map((q: { id: string }) => [q.id, q]));
    for (const p of FILE.questions[MID].picks) {
      expect((bank.get(p.bank_id) as { q: unknown }).q).toEqual(p.q);
    }
  });

  test('at least one answer shows the "We couldn’t check this" state', () => {
    const kinds = FILE.questions[MID].picks.flatMap((p: { claims: { kind: string }[] }) => p.claims.map((c) => c.kind));
    expect(kinds).toContain('absence');
  });

  test('the CLI passes, and its self-test catches every seeded fault', () => {
    expect(() => execFileSync('node', ['scripts/check-reader-questions.mjs', '--self-test'], { stdio: 'pipe' })).not.toThrow();
    expect(() => execFileSync('node', ['scripts/check-reader-questions.mjs'], { stdio: 'pipe' })).not.toThrow();
  });
});

test.describe('the gate catches', () => {
  const firstQuoting = (f: any) => f.questions[MID].picks[0].claims.find((c: any) => c.kind !== 'absence');
  const cases: [string, (f: any) => void][] = [
    ['a question not in the bank', (f) => { f.questions[MID].picks[0].bank_id = 'sp.invented'; }],
    ['a reworded question', (f) => { f.questions[MID].picks[0].q.es = '¿Cuándo?'; }],
    ['a code-built question', (f) => { f.questions[MID].picks[0].bank_id = 'core.votes'; f.questions[MID].picks[0].q = BANK.questions.find((q: any) => q.id === 'core.votes').q; }],
    ['a sentence with no quote', (f) => { firstQuoting(f).cites = []; }],
    ['a cite to a source the entry does not list', (f) => { firstQuoting(f).cites[0].src = 'nowhere'; }],
    ['displayed quoted words no cite holds', (f) => { const c = firstQuoting(f); c.en = c.en.replace('“', '“Never ').replace(/[^\S]*$/, ''); }],
    ['Spanish with a different number', (f) => { const c = firstQuoting(f); c.es = c.es.replace(/\d+/, '99'); }],
    ['Spanish with fewer quoted spans', (f) => { const c = firstQuoting(f); c.es = c.es.replace(/[«»]/g, ''); }],
    ['an empty Spanish sentence', (f) => { firstQuoting(f).es = ''; }],
    ['advocacy vocabulary', (f) => { f.questions[MID].picks[1].claims[0].en += ' Congress must fight it.'; }],
    ['a forecast', (f) => { f.questions[MID].picks[1].claims[0].en += ' A deal is likely to pass.'; }],
    ['a future vote', (f) => { f.questions[MID].picks[1].claims[0].en += ' The Senate will vote on it.'; }],
    ['a nightly rewrite', (f) => { f.questions[MID].rewritten_nightly = true; }],
    ['a future written date', (f) => { f.questions[MID].written = '2999-01-01'; }],
    ['too many sentences', (f) => { const c = f.questions[MID].picks[0].claims; while (c.length < 5) c.push({ ...c[0] }); }],
    ['an answer for a question that does not exist', (f) => { f.questions['no-such-question'] = f.questions[MID]; }],
  ];
  for (const [name, mutate] of cases) {
    test(name, () => {
      const f = clone();
      mutate(f);
      expect(checkReaderQuestions(f, BANK, MOMENTS).violations.length).toBeGreaterThan(0);
    });
  }
});

test.describe('helpers', () => {
  test('digit runs compare English and Spanish number formats', () => {
    expect(digitRuns('220–205 on December 11, 2026')).toEqual(digitRuns('220–205 el 11 de diciembre de 2026'));
  });
  test('the lint reads both languages', () => {
    expect(lintAnswerText('Senators fought the bill.', 'en').length).toBeGreaterThan(0);
    expect(lintAnswerText('El Senado votará la medida.', 'es').length).toBeGreaterThan(0);
    expect(lintAnswerText('The House passed it 400–15 on May 15.', 'en')).toEqual([]);
  });
});

test.describe('the block’s strings', () => {
  test('exist in both languages with the same arguments', () => {
    expect(Object.keys(es.readerQuestions).sort()).toEqual(Object.keys(en.readerQuestions).sort());
    expect(en.readerQuestions.written).toContain('{date}');
    expect(es.readerQuestions.written).toContain('{date}');
    expect(en.readerQuestions.written).toContain('not rewritten each night');
  });
});
