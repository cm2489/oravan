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

// A source that is a roll call's data file is linked as the chamber's readable
// page, never as the raw file (tests/timeline-record-links.spec.ts holds every
// Big Question page to that in a browser; this pins the one line that does it).
test('the drop-downs link a roll call as its readable page', () => {
  const src = readFileSync(join(process.cwd(), 'components/ReaderQuestions.tsx'), 'utf8');
  expect(src).toContain('href={rollCallPage(s.url)}');
  expect(src).not.toContain('href={s.url}');
});

test.describe('the committed answers', () => {
  test('pass the gate', () => {
    expect(checkReaderQuestions(FILE, BANK, MOMENTS).violations).toEqual([]);
  });

  // The funding question was the first to carry reader questions; the owner,
  // 2026-11-24: "These need to be on all the big questions." So the file may
  // hold any Big Question, and every entry meets the same terms.
  test('cover the funding question, and every entry is written once, dated, never rewritten nightly', () => {
    expect(Object.keys(FILE.questions)).toContain(MID);
    for (const [id, e] of Object.entries(FILE.questions) as [string, any][]) {
      expect(e.rewritten_nightly, id).toBe(false);
      expect(e.written, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.model, id).toBeTruthy();
      expect(e.picks.length, id).toBeGreaterThanOrEqual(5);
      expect(e.picks.length, id).toBeLessThanOrEqual(8);
    }
  });

  test('every question is the bank’s own text, in both languages', () => {
    const bank = new Map(BANK.questions.map((q: { id: string }) => [q.id, q]));
    for (const p of FILE.questions[MID].picks) {
      expect((bank.get(p.bank_id) as { q: unknown }).q).toEqual(p.q);
    }
  });

  test('absence lines come in both kinds: searched and not found, and "We couldn’t check this"', () => {
    const kinds = FILE.questions[MID].picks.flatMap((p: { claims: { kind: string; absence_kind?: string }[] }) =>
      p.claims.filter((c) => c.kind === 'absence').map((c) => c.absence_kind),
    );
    expect(kinds).toContain('not_found');
    expect(kinds).toContain('not_checked');
  });

  test('schema ids are not storage keys (no site key prefix)', () => {
    expect(FILE.schema).toBe('reader-questions/v1');
    expect(BANK.schema).toBe('reader-questions/bank-v1');
  });

  test('the CLI passes, and its self-test catches every seeded fault', () => {
    expect(() => execFileSync('node', ['scripts/check-reader-questions.mjs', '--self-test'], { stdio: 'pipe' })).not.toThrow();
    expect(() => execFileSync('node', ['scripts/check-reader-questions.mjs'], { stdio: 'pipe' })).not.toThrow();
  });
});

test.describe('the gate catches', () => {
  const firstQuoting = (f: any) => f.questions[MID].picks[0].claims.find((c: any) => c.kind !== 'absence');
  const absence = (f: any, kind: string) =>
    f.questions[MID].picks.flatMap((p: any) => p.claims).find((c: any) => c.kind === 'absence' && c.absence_kind === kind);
  const notChecked = (f: any) => absence(f, 'not_checked');
  const notFound = (f: any) => absence(f, 'not_found');
  const stopgapLine = (f: any) =>
    f.questions[MID].picks.find((p: any) => p.bank_id === 'core.alternatives').claims.find((c: any) => c.kind === 'absence');
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
    // Review of #544 (2026-11-23), defect 7.
    ['a fact passed off as a couldn’t-check line', (f) => { Object.assign(notChecked(f), { en: 'The House passed it 400–15 on May 15.', es: 'La Cámara la aprobó 400–15 el 15 de mayo.' }); }],
    ['a number on a couldn’t-check line', (f) => { Object.assign(notChecked(f), { en: 'We did not check the 400–15 vote.', es: 'No comprobamos la votación de 400–15.' }); }],
    ['a fact riding in on a not-found line', (f) => { const c = stopgapLine(f); c.en = c.en.replace('we found no new stopgap', 'we found no new stopgap, and the House passed H.R. 8469 400–15'); c.es = c.es.replace('no encontramos', 'la Cámara aprobó la H.R. 8469 400–15 y no encontramos'); }],
    ['a not-found line that names no terms looked for', (f) => { notFound(f).absent = []; }],
    ['an absence line with no kind', (f) => { delete notChecked(f).absence_kind; }],
    ['a Spanish sentence left as the English', (f) => { const c = firstQuoting(f); c.es = c.en.replace(/“/g, '«').replace(/”/g, '»'); }],
    ['a Spanish sentence identical to the English', (f) => { const c = notChecked(f); c.es = c.en; }],
    ['a question tagged for another type of Big Question', (f) => { const q = BANK.questions.find((x: any) => x.id === 'wp.binding'); Object.assign(f.questions[MID].picks[0], { bank_id: q.id, q: { ...q.q } }); }],
    ['an entry with no question type', (f) => { delete f.questions[MID].type; }],
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
