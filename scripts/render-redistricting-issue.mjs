/*
 * Renders the GitHub-issue markdown for the redistricting watch (S24) into a
 * file the workflow hands straight to `gh --body-file`. Runs from
 * .github/workflows/refresh-legislators.yml, right after
 * scripts/check-redistricting-watch.mjs.
 *
 * Why a script instead of shell in the YAML: everything interesting here is
 * text assembly and a date gate, and both belong somewhere unit-testable.
 * The pure renderers live in lib/redistricting-watch.mjs and
 * lib/rollover-tripwire.mjs (tests/redistricting-watch.unit.spec.ts,
 * tests/rollover-tripwire.unit.spec.ts); this file is only argv, file I/O,
 * and the CHANGED env var. The workflow step is then a label upsert, a title
 * lookup, and `gh` calls - no markdown, no jq loops, nothing that only ever
 * gets exercised on a Monday at 08:00 UTC.
 *
 * Stdlib-only (no npm ci in that job, same posture as
 * scripts/check-redistricting-watch.mjs).
 *
 *   node scripts/render-redistricting-issue.mjs board    <out.md>
 *   node scripts/render-redistricting-issue.mjs comment  <out.md>   # reads $CHANGED
 *   node scripts/render-redistricting-issue.mjs rollover <out.md>   # prints due|not-due
 *
 * `rollover` prints exactly `due` or `not-due` on stdout and writes the file
 * only when due. The workflow gates on that word - NOT on the exit code, so
 * that a crash here can never be mistaken for "the window isn't open yet"
 * and silently skip a dated deadline.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  renderStatusBoard,
  renderChangeComment,
  statesWithDetections,
} from '../lib/redistricting-watch.mjs';
import { renderRolloverIssueBody } from '../lib/rollover-tripwire.mjs';

const WATCH_PATH = 'data/redistricting-watch.json';

const [mode, outPath] = process.argv.slice(2);
if (!mode || !outPath) {
  console.error('::error::usage: render-redistricting-issue.mjs <board|comment|rollover> <out.md>');
  process.exit(1);
}

const committed = JSON.parse(readFileSync(WATCH_PATH, 'utf8'));
const trackedCount = Object.keys(committed).length;
const today = new Date();

if (mode === 'board') {
  writeFileSync(outPath, renderStatusBoard(committed, today));
} else if (mode === 'comment') {
  // The same JSON array check-redistricting-watch.mjs wrote to GITHUB_OUTPUT.
  const changed = JSON.parse(process.env.CHANGED || '[]');
  if (changed.length === 0) {
    console.error('::error::comment mode called with no changed states - the workflow should not have reached here');
    process.exit(1);
  }
  writeFileSync(outPath, renderChangeComment(changed, trackedCount, today));
} else if (mode === 'rollover') {
  const body = renderRolloverIssueBody(statesWithDetections(committed), today);
  if (body === null) {
    console.log('not-due');
  } else {
    writeFileSync(outPath, body);
    console.log('due');
  }
} else {
  console.error(`::error::unknown mode '${mode}' (expected board|comment|rollover)`);
  process.exit(1);
}
