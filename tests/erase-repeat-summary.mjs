// TEMPORARY DIAGNOSIS (PR #521, check 5, 2026-11-19). REMOVE BEFORE MERGE.
// Reads the JSON report of the `erase-repeat` job (.github/workflows/ci.yml)
// and prints, to the job's log: runs and failures per test and project, then
// the first line of each failure and its diag.txt (tests/erase-reach.spec.ts),
// for up to six failures, and one passing run's diag.txt for comparison.
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const rows = [];
function walk(suite) {
  for (const s of suite.suites ?? []) walk(s);
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      for (const r of t.results ?? []) rows.push({ title: spec.title, line: spec.line, project: t.projectName, result: r });
    }
  }
}
for (const s of report.suites ?? []) walk(s);

const tally = new Map();
for (const { title, line, project, result } of rows) {
  const k = `${project} :${line} ${title}`;
  const t = tally.get(k) ?? { runs: 0, failed: 0 };
  t.runs += 1;
  if (result.status !== 'passed') t.failed += 1;
  tally.set(k, t);
}
console.log('=== runs per test (no retries) ===');
for (const [k, t] of [...tally].sort()) console.log(`${String(t.failed).padStart(3)} failed of ${String(t.runs).padStart(3)}  ${k}`);

const diagOf = (result) => {
  const a = (result.attachments ?? []).find((x) => x.name === 'diag.txt');
  return a?.body ? Buffer.from(a.body, 'base64').toString('utf8') : '(no diag)';
};
const failed = rows.filter((r) => r.result.status !== 'passed');
console.log(`\n=== ${failed.length} failed runs; the first six in full ===`);
for (const { title, line, project, result } of failed.slice(0, 6)) {
  const err = (result.errors?.[0]?.message ?? result.error?.message ?? '').split('\n').slice(0, 6).join('\n');
  console.log(`\n--- FAILED ${project} :${line} ${title}\n${err}\n--- diag.txt\n${diagOf(result)}`);
}
const passed = rows.find((r) => r.result.status === 'passed' && /another tab saves a different ZIP/.test(r.title));
if (passed) console.log(`\n=== one passing run for comparison: ${passed.project} :${passed.line} ===\n${diagOf(passed.result)}`);
