/**
 * Moments CI gate — CLI wrapper (same split as check-rollover-tripwire.mjs /
 * lib/rollover-tripwire.mjs: the logic lives import-free in
 * lib/moments-gate.mjs so the unit suite can import it; this file does the
 * file I/O and the exit code). Same check-script family as
 * check-messages-parity.mjs / check-naming.mjs.
 *
 *   node scripts/check-moments.mjs
 *
 * Validates data/moments.json: schema, bilingual parity, vehicle resolution
 * against data/bills.json, qualifying-signal shape, dates, the 6-live cap,
 * and the forbidden-vocabulary lint in both languages. Exits 1 on any
 * violation; warnings (terminal vehicles, elapsed review_by) print without
 * failing — see lib/moments-gate.mjs's header for why those are soft.
 */
import { readFileSync } from 'node:fs';
import { checkMoments, TERMINAL_VEHICLE_STATUSES } from '../lib/moments-gate.mjs';
import { TERMINAL_STATUSES } from '../lib/urgency.mjs';

// The gate's import-free copy of the terminal set must never drift from the
// real one (also pinned in tests/moments.unit.spec.ts, but a check script
// should not trust a test it doesn't run).
const a = [...TERMINAL_VEHICLE_STATUSES].sort().join(',');
const b = [...TERMINAL_STATUSES].sort().join(',');
if (a !== b) {
  console.error(`::error::check-moments: lib/moments-gate.mjs TERMINAL_VEHICLE_STATUSES (${a}) drifted from lib/urgency.mjs TERMINAL_STATUSES (${b})`);
  process.exit(1);
}

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const moments = read('data/moments.json');
const bills = read('data/bills.json');

const billSlugs = new Set(bills.map((x) => x.full_identifier));
const statusBySlug = new Map(bills.map((x) => [x.full_identifier, x.status]));

const { violations, warnings } = checkMoments(moments, billSlugs, (slug) => statusBySlug.get(slug));

for (const w of warnings) console.warn(`::warning::check-moments: ${w}`);
if (violations.length) {
  for (const v of violations) console.error(`::error::check-moments: ${v}`);
  console.error(`check-moments: ${violations.length} violation(s) in data/moments.json`);
  process.exit(1);
}
console.log('check-moments passed: data/moments.json is schema-valid, bilingual, vocabulary-clean, and inside the live cap.');
