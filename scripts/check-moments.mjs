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
import { checkMoments, lintForbidden, TERMINAL_VEHICLE_STATUSES } from '../lib/moments-gate.mjs';
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

/*
 * The chrome copy gets the SAME vocabulary lint as the curated content.
 *
 * The lint only ever read data/moments.json, so the surrounding UI strings —
 * which sit beside that content and read as the same voice — were ungoverned.
 * Three English strings had drifted to "fight", a word this project's own
 * table bans in a Moment's prose, while their Spanish siblings had
 * independently chosen neutral words (pre-launch audit, 2026-07-25). A rule
 * that governs the paragraph but not the heading above it is half a rule.
 */
const messages = { en: read('messages/en.json'), es: read('messages/es.json') };
const chromeViolations = [];
for (const [lang, doc] of Object.entries(messages)) {
  const walk = (node, path) => {
    for (const [k, v] of Object.entries(node ?? {})) {
      const at = path ? `${path}.${k}` : k;
      if (typeof v === 'string') {
        for (const word of lintForbidden(v, lang)) {
          chromeViolations.push(`messages/${lang}.json ${at}: forbidden vocabulary "${word}" — Moments chrome shares the curated voice (spec §3.3)`);
        }
      } else if (v && typeof v === 'object') {
        walk(v, at);
      }
    }
  };
  walk(doc.moments, 'moments');
}

const { violations, warnings } = checkMoments(moments, billSlugs, (slug) => statusBySlug.get(slug));

for (const w of warnings) console.warn(`::warning::check-moments: ${w}`);
violations.push(...chromeViolations);
if (violations.length) {
  for (const v of violations) console.error(`::error::check-moments: ${v}`);
  console.error(`check-moments: ${violations.length} violation(s) in data/moments.json`);
  process.exit(1);
}
console.log('check-moments passed: data/moments.json is schema-valid, bilingual, vocabulary-clean, and inside the live cap.');
