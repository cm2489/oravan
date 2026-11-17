/**
 * CI gate for data/related-bills.json — the same judgement the nightly
 * dead-man's-switch runs before its commit (verifyRelatedBills,
 * lib/related-bills.mjs), so a pull request that touches the file, the writer
 * or the rule is checked before it reaches main.
 *
 *   node scripts/check-related-bills.mjs
 *   node scripts/check-related-bills.mjs --self-test
 *
 * WHAT IT PROTECTS. The file decides whose press a bill page's coverage box
 * lists (owner, 2026-11-13, his card on a bill's twin: "Yes, show it under the
 * bill as it is."). Only the record's "Identical bill" relation may put one
 * bill's articles under another (hard rule 6), never a bill under itself and
 * never across Congresses.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  KEPT_RELATION_TYPES,
  RELATED_BILLS_PATH,
  RELATED_BILLS_SCHEMA,
  identicalFromRecord,
  twinsOf,
  verifyRelatedBills,
} from '../lib/related-bills.mjs';

const url = (p) => new URL(`../${p}`, import.meta.url);
const today = new Date().toISOString().slice(0, 10);

if (process.argv.includes('--self-test')) {
  const meta = { schema: RELATED_BILLS_SCHEMA, kept_types: [...KEPT_RELATION_TYPES], filled_at: today };
  const good = { _meta: meta, _checkedAt: { 'hr-1-119': today }, 'hr-1-119': [{ slug: 's-2-119', type: 'Identical bill', identifiedBy: ['CRS'] }] };
  const bad = [
    ['a merely related bill', { ...good, 'hr-1-119': [{ slug: 's-2-119', type: 'Related bill', identifiedBy: ['CRS'] }] }],
    ['a bill listed as its own twin', { ...good, 'hr-1-119': [{ slug: 'hr-1-119', type: 'Identical bill', identifiedBy: ['CRS'] }] }],
    ['a twin of another Congress', { ...good, 'hr-1-119': [{ slug: 's-2-118', type: 'Identical bill', identifiedBy: ['CRS'] }] }],
    ['a relation with no check day', { ...good, _checkedAt: {} }],
    ['a check day in the future', { ...good, _checkedAt: { 'hr-1-119': '2999-01-01' } }],
    ['a wrong schema', { ...good, _meta: { ...meta, schema: 'related-bills/v0' } }],
    ['a widened kept_types', { ...good, _meta: { ...meta, kept_types: ['Identical bill', 'Related bill'] } }],
    ['no identifier', { ...good, 'hr-1-119': [{ slug: 's-2-119', type: 'Identical bill', identifiedBy: [] }] }],
    ['no last-filled day', { ...good, _meta: { schema: RELATED_BILLS_SCHEMA, kept_types: [...KEPT_RELATION_TYPES] } }],
    ['a last-filled day in the future', { ...good, _meta: { ...meta, filled_at: '2999-01-01' } }],
  ];
  let ok = verifyRelatedBills({ data: good, today }).failures.length === 0;
  if (!ok) console.error('self-test: a good file was rejected');
  for (const [name, data] of bad) {
    if (verifyRelatedBills({ data, today }).failures.length === 0) {
      console.error(`self-test: ${name} was NOT rejected`);
      ok = false;
    }
  }
  // The reader ignores a non-kept row even if one ever got past the gate.
  if (twinsOf({ 'hr-1-119': [{ slug: 's-2-119', type: 'Related bill' }] }, 'hr-1-119').length !== 0) {
    console.error('self-test: twinsOf followed a "Related bill" row');
    ok = false;
  }
  // The parser keeps only "Identical bill" from a record payload.
  const parsed = identicalFromRecord(
    {
      relatedBills: [
        { congress: 119, number: 2, type: 'S', relationshipDetails: [{ type: 'Identical bill', identifiedBy: 'CRS' }] },
        { congress: 119, number: 3, type: 'HRES', relationshipDetails: [{ type: 'Procedurally related', identifiedBy: 'House' }] },
        { congress: 119, number: 4, type: 'S', relationshipDetails: [{ type: 'Related bill', identifiedBy: 'CRS' }] },
      ],
    },
    'hr-1-119'
  );
  if (parsed.length !== 1 || parsed[0].slug !== 's-2-119') {
    console.error(`self-test: identicalFromRecord kept ${JSON.stringify(parsed)}`);
    ok = false;
  }
  console.log(ok ? `check-related-bills self-test: ok (${bad.length} bad shapes rejected)` : 'check-related-bills self-test: FAILED');
  process.exit(ok ? 0 : 1);
}

if (!existsSync(url(RELATED_BILLS_PATH))) {
  console.error(`::error::${RELATED_BILLS_PATH} is missing — lib/coverage.ts imports it`);
  process.exit(1);
}
const data = JSON.parse(readFileSync(url(RELATED_BILLS_PATH), 'utf8'));
const bills = JSON.parse(readFileSync(url('data/bills.json'), 'utf8'));
const knownSlugs = new Set(bills.map((b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase()));
const { failures, notes } = verifyRelatedBills({ data, fileBytes: statSync(url(RELATED_BILLS_PATH)).size, today, knownSlugs });
for (const n of notes) console.log(n);
for (const f of failures) console.error(`::error::${f}`);
process.exit(failures.length ? 1 : 0);
