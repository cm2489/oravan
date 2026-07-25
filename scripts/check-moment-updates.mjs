/**
 * Moment-updates CI gate — CLI wrapper. Exactly the split
 * scripts/check-moments.mjs uses: all the logic lives import-free-ish in
 * lib/moment-updates-gate.mjs (its only import is the v1 vocabulary table)
 * so tests/moment-updates.unit.spec.ts can run it under Playwright's
 * transform; this file does the file I/O, the byte size, and the exit code.
 *
 *   node scripts/check-moment-updates.mjs
 *
 * Validates data/moment-updates.json against data/moments.json and
 * data/bills.json: root shape and schema version, id derivation and
 * uniqueness, class/source vocabulary, vehicle membership in THAT moment,
 * the legislative-day rule, no future dates, EN/ES parity, the three lint
 * layers of the editorial law (inherited vocabulary, speculation on record
 * classes, attribution on press clusters), press-cluster corroboration,
 * corrections that resolve, the per-day storage ceiling, revision shape and
 * chronology, and the file-size ceiling.
 *
 * Exits 1 on any violation. Warnings (a busy day past the render cap, a long
 * one-liner, a live moment with no summary yet) print without failing.
 *
 * A MISSING data/moment-updates.json is not a failure: the collector (slice
 * S3) is what first writes it on a fresh branch, and a gate that reddens CI
 * for a file nobody has generated yet teaches people to ignore the gate.
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { checkMomentUpdates, CLASS_PRIORITY, UPDATE_CLASSES } from '../lib/moment-updates-gate.mjs';

// The priority table and the class list must never drift apart: a class with
// no priority silently sorts last and can be crowded out of its own day.
const missingPriority = UPDATE_CLASSES.filter((c) => typeof CLASS_PRIORITY[c] !== 'number');
const extraPriority = Object.keys(CLASS_PRIORITY).filter((c) => !UPDATE_CLASSES.includes(c));
if (missingPriority.length || extraPriority.length) {
  console.error(
    `::error::check-moment-updates: CLASS_PRIORITY drifted from UPDATE_CLASSES (missing: ${missingPriority.join(',') || 'none'}; extra: ${extraPriority.join(',') || 'none'})`,
  );
  process.exit(1);
}

const url = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => JSON.parse(readFileSync(url(p), 'utf8'));

const UPDATES_PATH = 'data/moment-updates.json';
if (!existsSync(url(UPDATES_PATH))) {
  console.log(`check-moment-updates: ${UPDATES_PATH} does not exist yet — nothing to validate.`);
  process.exit(0);
}

const updates = read(UPDATES_PATH);
const moments = read('data/moments.json');
const bills = read('data/bills.json');
const fileBytes = statSync(url(UPDATES_PATH)).size;

const billSlugs = new Set(bills.map((b) => b.full_identifier));

const { violations, warnings } = checkMomentUpdates(updates, moments, billSlugs, { fileBytes });

for (const w of warnings) console.warn(`::warning::check-moment-updates: ${w}`);
if (violations.length) {
  for (const v of violations) console.error(`::error::check-moment-updates: ${v}`);
  console.error(`check-moment-updates: ${violations.length} violation(s) in ${UPDATES_PATH}`);
  process.exit(1);
}

const momentCount = Object.keys(updates).filter((k) => k !== '_meta').length;
const updateCount = Object.entries(updates)
  .filter(([k]) => k !== '_meta')
  .reduce((n, [, e]) => n + (e.updates?.length ?? 0), 0);
console.log(
  `check-moment-updates passed: ${updateCount} update(s) across ${momentCount} moment(s), ${fileBytes} bytes — record-anchored, bilingual, speculation-free, inside every cap.`,
);
