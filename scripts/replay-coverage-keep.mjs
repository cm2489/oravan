/**
 * Replay the coverage keep rule over what is ALREADY STORED for every live Big
 * Question vehicle, and drop what fails it. (The 2026-09-27 audit, SY-04.)
 *
 *   node scripts/replay-coverage-keep.mjs            # rewrite data/coverage.json
 *   node scripts/replay-coverage-keep.mjs --dry-run  # print the verdicts, write nothing
 *
 * WHY. The nightly coverage sync now shows its relevance gate only articles
 * that cite the bill or print a name it is known by (citesBill, "The keep
 * rule" in scripts/coverage-query.mjs). That fixes what a night ADDS. What
 * earlier, laxer nights kept is still in data/coverage.json — the four
 * off-topic articles on H.Con.Res. 89 among them — and the sync only re-judges
 * a stored article when its search happens to return it again. This replays
 * the rule over the stored articles themselves.
 *
 * WHAT IT DOES, EXACTLY. For each vehicle of a non-retired Big Question
 * (momentVehicles over data/moments.json — the set the nightly holds to the
 * same rule, with the same function, holdToKeepRule), it keeps the stored
 * articles whose title or snippet cites the bill or prints one of its names,
 * and drops the rest; a vehicle left with none leaves the file, as an
 * uncovered bill does. Every other key — other bills, `_checkedAt`, `_note` —
 * is written back untouched, in the same order, in the same compact JSON the
 * sync writes.
 *
 * DETERMINISTIC AND FREE: no network, no model, no environment variable. It
 * reads data/bills.json, data/moments.json and data/coverage.json, and writes
 * only data/coverage.json (and nothing at all under --dry-run). Running it a
 * second time changes nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { holdToKeepRule, keepRuleMatch } from './coverage-query.mjs';
import { momentVehicles } from './moment-updates-map.mjs';

const COVERAGE_PATH = 'data/coverage.json';
const DRY_RUN = process.argv.includes('--dry-run');

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
const bills = readJSON('data/bills.json');
const moments = readJSON('data/moments.json');
const coverage = readJSON(COVERAGE_PATH);

const vehicles = [...new Set(momentVehicles(moments).map((v) => String(v.slug).toLowerCase()))];
const { coverage: next, report } = holdToKeepRule({ coverage, bills, slugs: vehicles });

const billSlugs = (c) => Object.keys(c).filter((k) => !k.startsWith('_'));
const articleCount = (c) => billSlugs(c).reduce((n, k) => n + (Array.isArray(c[k]) ? c[k].length : 0), 0);
const bySlug = new Map(bills.map((b) => [`${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase(), b]));

console.log(
  `replay-coverage-keep: ${vehicles.length} live Big Question vehicle(s), ${report.length} with stored coverage${DRY_RUN ? ' (dry run — nothing written)' : ''}`
);
for (const r of report) {
  if (!r.judged) {
    console.log(`  ${r.slug}: no bill record in data/bills.json — not judged, ${r.before} article(s) left as they are`);
    continue;
  }
  console.log(`  ${r.slug}: ${r.before} -> ${r.after} stored`);
  const b = bySlug.get(r.slug);
  for (const a of coverage[r.slug] ?? []) {
    const why = keepRuleMatch(b, a);
    console.log(`    ${why ? `keep (${why})` : 'DROP'}  ${a.source}${a.rated === true ? '' : ' [not rated]'} | ${String(a.title ?? '').slice(0, 110)}`);
  }
}
const dropped = report.reduce((n, r) => n + r.dropped.length, 0);
const emptied = report.filter((r) => r.judged && r.after === 0).length;
console.log(
  `replay-coverage-keep: ${dropped} stored article(s) dropped on ${report.filter((r) => r.dropped.length).length} vehicle(s)` +
    ` (${emptied} left with no coverage); data/coverage.json ${billSlugs(coverage).length} -> ${billSlugs(next).length} bills, ` +
    `${articleCount(coverage)} -> ${articleCount(next)} articles`
);

if (!DRY_RUN && dropped > 0) writeFileSync(COVERAGE_PATH, JSON.stringify(next));
