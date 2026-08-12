/**
 * CI gate for data/floor-signals.json — the same judgement the nightly
 * dead-man's-switch runs (verifyFloorSignals, scripts/floor-signals-parse.mjs),
 * wired where it actually catches a bad write.
 *
 *   node scripts/check-floor-signals.mjs
 *   node scripts/check-floor-signals.mjs --self-test
 *
 * WHY BOTH HERE AND IN verify-sync.mjs. The file is written by the HOURLY
 * newsdesk workflow, which commits straight to main and then dispatches
 * ci.yml against the pushed data; verify-sync.mjs only runs in the NIGHTLY
 * sync. Without this step a bad hourly write would sit on the site until the
 * small hours. Same reasoning, and the same split, as
 * scripts/check-moment-updates.mjs beside lib/verify-moment-updates.mjs.
 *
 * A MISSING file is not a failure: scripts/floor-signals.mjs is what first
 * writes it, and a gate that reddens CI for a file nobody has generated yet
 * teaches people to ignore the gate.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  FLOOR_SIGNALS_PATH,
  FLOOR_SIGNALS_SCHEMA,
  verifyFloorSignals,
} from './floor-signals-parse.mjs';

const url = (p) => new URL(`../${p}`, import.meta.url);

// --self-test: prove the gate still rejects the shapes it exists to reject,
// so a refactor that quietly turned it into a no-op is caught by the gate
// itself — the same pattern check-claim-truth/check-server-json keep.
if (process.argv.includes('--self-test')) {
  const cases = [
    ['no quote', { _meta: { schema: FLOOR_SIGNALS_SCHEMA, fetched_at: new Date().toISOString() }, signals: { 'hr-1-119': { tier0: { source: 'daily-digest', quote: '', quote_lang: 'en', url: 'https://x/y', published: '2026-08-04' }, fetched_at: new Date().toISOString() } } }],
    ['translated quote', { _meta: { schema: FLOOR_SIGNALS_SCHEMA, fetched_at: new Date().toISOString() }, signals: { 'hr-1-119': { tier0: { source: 'daily-digest', quote: 'El Senado votará…', quote_lang: 'es', url: 'https://x/y', published: '2026-08-04' }, fetched_at: new Date().toISOString() } } }],
    ['unknown schema', { _meta: { schema: 'floor-signals/v99', fetched_at: new Date().toISOString() }, signals: {} }],
    ['future date', { _meta: { schema: FLOOR_SIGNALS_SCHEMA, fetched_at: new Date().toISOString() }, signals: { 'hr-1-119': { tier0: { source: 'daily-digest', quote: 'Senate will vote.', quote_lang: 'en', url: 'https://x/y', published: '2099-01-01' }, fetched_at: new Date().toISOString() } } }],
  ];
  let ok = true;
  for (const [name, data] of cases) {
    const { failures } = verifyFloorSignals({ data, fileBytes: 100 });
    if (failures.length === 0) {
      console.error(`::error::check-floor-signals --self-test: "${name}" was ACCEPTED by the gate`);
      ok = false;
    }
  }
  const good = { _meta: { schema: FLOOR_SIGNALS_SCHEMA, fetched_at: new Date().toISOString(), sources: {} }, signals: {}, nominations: {} };
  if (verifyFloorSignals({ data: good, fileBytes: 100 }).failures.length > 0) {
    console.error('::error::check-floor-signals --self-test: a valid empty file was REJECTED by the gate');
    ok = false;
  }
  if (!ok) process.exit(1);
  console.log('check-floor-signals --self-test passed');
  process.exit(0);
}

if (!existsSync(url(FLOOR_SIGNALS_PATH))) {
  console.log(`check-floor-signals: ${FLOOR_SIGNALS_PATH} does not exist yet — nothing to validate.`);
  process.exit(0);
}

const data = JSON.parse(readFileSync(url(FLOOR_SIGNALS_PATH), 'utf8'));
const bills = JSON.parse(readFileSync(url('data/bills.json'), 'utf8'));
const { failures, warnings, notes } = verifyFloorSignals({
  data,
  fileBytes: statSync(url(FLOOR_SIGNALS_PATH)).size,
  knownSlugs: new Set(bills.map((b) => b.full_identifier)),
});

for (const n of notes) console.log(`check-floor-signals: ${n}`);
for (const w of warnings) console.warn(`::warning::check-floor-signals: ${w}`);
if (failures.length) {
  for (const f of failures) console.error(`::error::check-floor-signals: ${f}`);
  process.exit(1);
}
console.log('check-floor-signals passed — every T0 signal carries a dated, attributed, English-verbatim quote of the record.');
