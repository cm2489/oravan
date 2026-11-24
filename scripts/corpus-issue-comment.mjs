// Comment on an open corpus issue only when there is something new to say
// (2026-11-23; the reasoning is in lib/corpus-issue.mjs's header).
//
// Two modes, both called from .github/workflows/sync-bills.yml after the step
// has found the open issue's number:
//
//   node scripts/corpus-issue-comment.mjs --issue N --body-file F
//       Tonight's sweep found something. Post F on issue N only if F holds a
//       finding that the issue's body and comments do not already hold.
//
//   node scripts/corpus-issue-comment.mjs --issue N --clean
//       Tonight's sweep came back clean. Say so once, and say the issue can
//       be closed, unless the issue's newest text already says it.
//
// Plain node, no key, no paid call: it reads and writes through the `gh` CLI
// on the workflow's own GITHUB_TOKEN (GH_TOKEN in the step's env). Any `gh`
// failure exits non-zero; the workflow decides what that costs (the scaffold
// steps and the clean steps are continue-on-error).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cleanComment, needsCleanComment, unseenFindings } from '../lib/corpus-issue.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'cm2489/oravan';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/** The issue body, then every comment oldest first. */
function threadTexts(issue) {
  const body = gh(['issue', 'view', issue, '--repo', REPO, '--json', 'body', '--jq', '.body']);
  const comments = gh(['api', '--paginate', `repos/${REPO}/issues/${issue}/comments?per_page=100`, '--jq', '.[].body | @json'])
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  return [body, ...comments];
}

const issue = arg('issue');
if (!issue || !/^\d+$/.test(issue)) {
  console.error('::error::corpus-issue-comment: --issue <number> is required');
  process.exit(2);
}

const texts = threadTexts(issue);

if (process.argv.includes('--clean')) {
  if (!needsCleanComment(texts)) {
    console.log(`#${issue}: the sweep is clean and the issue already says so — nothing posted`);
    process.exit(0);
  }
  gh(['issue', 'comment', issue, '--repo', REPO, '--body', cleanComment(new Date().toISOString().slice(0, 10))]);
  console.log(`#${issue}: the sweep is clean — posted the one "can be closed" comment`);
  process.exit(0);
}

const bodyFile = arg('body-file');
if (!bodyFile) {
  console.error('::error::corpus-issue-comment: --body-file <path> or --clean is required');
  process.exit(2);
}
const report = readFileSync(bodyFile, 'utf8');
const fresh = unseenFindings(report, texts);
if (!fresh.length) {
  console.log(`#${issue}: tonight's report holds nothing this issue does not already hold — nothing posted`);
  process.exit(0);
}
gh(['issue', 'comment', issue, '--repo', REPO, '--body-file', bodyFile]);
console.log(`#${issue}: ${fresh.length} new finding(s) tonight — posted tonight's report`);
