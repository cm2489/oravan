/**
 * Reader-questions gate — CLI wrapper. The logic lives in
 * lib/reader-questions-gate.mjs so tests/reader-questions-gate.unit.spec.ts
 * can run it; this file does the file I/O, the self-test and the exit code.
 *
 *   node scripts/check-reader-questions.mjs --self-test
 *   node scripts/check-reader-questions.mjs
 *
 * Validates data/reader-questions.json against the bank
 * (data/reader-questions-bank.json) and data/moments.json: schema, the
 * English/Spanish parity of every sentence, a quote and a source on every
 * sentence that is not an "absence" line, every question id in the bank, and
 * the forbidden-vocabulary, speculation and future-vote lints. See the lib
 * file's header for the full list and for what it cannot check (the quotes
 * were matched word for word against saved sources when the answers were
 * written; this gate does not re-fetch them).
 *
 * A missing data/reader-questions.json is not a failure.
 */
import { existsSync, readFileSync } from 'node:fs';
import { checkReaderQuestions } from '../lib/reader-questions-gate.mjs';

const url = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => JSON.parse(readFileSync(url(p), 'utf8'));
const FILE = 'data/reader-questions.json';

if (process.argv.includes('--self-test')) {
  // The gate must still catch what it exists to catch, or its "clean"
  // verdict on the real file means nothing.
  const bank = read('data/reader-questions-bank.json');
  const moments = read('data/moments.json');
  const mid = Object.keys(moments)[0];
  const b = bank.questions.find((q) => !q.deterministic);
  const good = () => ({
    schema: 'oravan.reader-questions/v1',
    bank: bank.schema,
    questions: {
      [mid]: {
        written: '2026-11-22',
        record_as_of: '2026-11-22',
        model: 'test-model',
        rewritten_nightly: false,
        sources: { s: { kind: 'record', url: 'https://www.govinfo.gov/x', title: { en: 'A', es: 'A' } } },
        picks: [
          {
            bank_id: b.id,
            q: { ...b.q },
            claims: [
              { kind: 'record', en: 'It runs to “December 11, 2026.”', es: 'Dura hasta el «11 de diciembre de 2026».', cites: [{ src: 's', quote: 'December 11, 2026.' }] },
              { kind: 'absence', en: 'We found no estimate.', es: 'No encontramos ninguna estimación.', searched: ['s'] },
            ],
          },
        ],
      },
    },
  });
  const cases = [
    ['a question written outside the bank', (f) => { f.questions[mid].picks[0].bank_id = 'made.up'; }],
    ['a question reworded', (f) => { f.questions[mid].picks[0].q.en += ' really'; }],
    ['a sentence with no cite', (f) => { f.questions[mid].picks[0].claims[0].cites = []; }],
    ['a quote shown that no cite holds', (f) => { f.questions[mid].picks[0].claims[0].en = 'It runs to “December 4, 2026.”'; f.questions[mid].picks[0].claims[0].es = 'Dura hasta el «4 de diciembre de 2026».'; }],
    ['Spanish with a different number', (f) => { f.questions[mid].picks[0].claims[0].es = 'Dura hasta el «12 de diciembre de 2026».'; }],
    ['a missing Spanish sentence', (f) => { f.questions[mid].picks[0].claims[1].es = ''; }],
    ['advocacy vocabulary', (f) => { f.questions[mid].picks[0].claims[1].en = 'We found no plan to stop it.'; }],
    ['a forecast', (f) => { f.questions[mid].picks[0].claims[1].en = 'The Senate is expected to act.'; }],
    ['a future vote', (f) => { f.questions[mid].picks[0].claims[1].en = 'The Senate will vote on it.'; }],
    ['a nightly rewrite', (f) => { f.questions[mid].rewritten_nightly = true; }],
    ['an absence line with no sources searched', (f) => { f.questions[mid].picks[0].claims[1].searched = []; }],
    ['a cite to an unlisted source', (f) => { f.questions[mid].picks[0].claims[0].cites[0].src = 'nope'; }],
  ];
  const clean = checkReaderQuestions(good(), bank, moments);
  let failed = clean.violations.length > 0;
  if (failed) console.error(`::error::self-test: the clean fixture fails: ${clean.violations.join(' | ')}`);
  for (const [name, mutate] of cases) {
    const f = good();
    mutate(f);
    if (checkReaderQuestions(f, bank, moments).violations.length === 0) {
      console.error(`::error::self-test: did not catch ${name}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(`check-reader-questions self-test: the clean fixture passes and all ${cases.length} seeded faults are caught.`);
  process.exit(0);
}

if (!existsSync(url(FILE))) {
  console.log(`check-reader-questions: ${FILE} does not exist — nothing to validate.`);
  process.exit(0);
}

const { violations, warnings } = checkReaderQuestions(read(FILE), read('data/reader-questions-bank.json'), read('data/moments.json'));
for (const w of warnings) console.log(`::warning::check-reader-questions: ${w}`);
if (violations.length) {
  for (const v of violations) console.error(`::error::check-reader-questions: ${v}`);
  console.error(`check-reader-questions FAILED: ${violations.length} violation(s).`);
  process.exit(1);
}
const file = read(FILE);
const n = Object.values(file.questions).reduce((a, e) => a + e.picks.length, 0);
console.log(`check-reader-questions passed: ${n} answer(s) across ${Object.keys(file.questions).length} Big Question(s) — bank-only questions, every sentence sourced, EN/ES parity, vocabulary-clean.`);
