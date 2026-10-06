/**
 * Commit-trailer check (owner's answer T20, 2026-10-03). Every commit a helper
 * makes carries `Co-Authored-By: Claude <Model> <noreply@anthropic.com>` naming
 * the model that wrote it, plus a `Claude-Session:` line. Helpers never run on
 * Fable, so a Fable trailer is refused. Local only: it runs as the
 * `.githooks/commit-msg` hook (one-time setup: `git config core.hooksPath
 * .githooks`); CI does not run it because squash-merge messages are written by
 * the orchestrator.
 *
 * Usage: node scripts/check-commit-trailer.mjs [message-file]
 * With no argument it reads `git log -1 --format=%B`. Exit 0 = ok, 1 = refused
 * (one plain line on stderr).
 *
 * Exempt: merge commits (subject starts "Merge ", or MERGE_HEAD exists), and
 * the pipeline's data commits (author name `oravan-sync` AND subject starting
 * `chore(data):`; the author comes from GIT_AUTHOR_NAME, else git's configured
 * identity).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkMessage } from '../lib/commit-trailer.mjs';

function authorNameNow() {
  if (process.env.GIT_AUTHOR_NAME) return process.env.GIT_AUTHOR_NAME;
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  const message = file
    ? readFileSync(file, 'utf8')
    : execFileSync('git', ['log', '-1', '--format=%B'], { encoding: 'utf8' });
  let isMerge = false;
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim();
    isMerge = existsSync(`${gitDir}/MERGE_HEAD`);
  } catch {
    // not in a repository: fall through to the message checks
  }
  const problem = checkMessage(message, { authorName: authorNameNow(), isMerge, env: process.env });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
