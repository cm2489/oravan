// The weekly owner note (2026-11-23). What it says, and why, is
// lib/weekly-note.mjs's header; this file reads the sources and posts.
//
// Run by .github/workflows/weekly-note.yml every Monday at 14:00 UTC, which
// is 9 AM ET while Eastern Standard Time holds (and 10 AM ET under daylight
// time, from Mar 14, 2027).
//
//   npx tsx scripts/weekly-note.mjs            open this week's note, close last week's
//   npx tsx scripts/weekly-note.mjs --dry-run  print the title and body; touch nothing
//
// WHAT IT DOES, in order:
//   1. reads five sources, each on its own, so one failing never blanks the
//      others: #242's body and recent comments (Needs you, AI spend), the
//      counters database (visitors: aggregate counts only, rule 1), the
//      scheduled sync-bills runs, and the open `moment-candidate` issues;
//   2. opens a NEW issue titled "📬 Oravan this week — <Monday>", labeled
//      `weekly-note` and ASSIGNED to the owner (the assignment is what emails
//      him; nothing in the body @-mentions anyone);
//   3. closes every other open `weekly-note` issue, without a comment.
//
// MUST run via `npx tsx`, not plain node, for the reason
// scripts/daily-metrics.mjs gives: it imports lib/usage.ts and lib/ratelimit.ts
// unchanged, so the keys it reads are the keys the live routes write. It only
// READS them. With the counters env absent it says so in the visitors line and
// still posts.
//
// Rule 10: no secret is ever printed. The counters URL and token are read by
// lib/upstash.ts and never touch this file's output; `gh` uses GH_TOKEN.
// $0: no model call, no paid API.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAGEVIEW_SURFACES, readPageviewWindow } from '../lib/usage';
import { readDistinctAddressCount } from '../lib/ratelimit';
import { trailingWindowDays } from '../lib/traffic-metrics.mjs';
import {
  HEALTH_ISSUE,
  NEEDS_MAX_AGE_DAYS,
  NOTE_ASSIGNEE,
  NOTE_LABEL,
  candidatesLine,
  nightlyLine,
  noteBody,
  noteTitle,
  pickNeeds,
  spendLine,
  visitorsLine,
} from '../lib/weekly-note.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'cm2489/oravan';

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Run one read; a failure is logged as a warning and becomes null. */
async function attempt(what, fn) {
  try {
    return await fn();
  } catch (e) {
    const msg = String(e?.stderr || e?.message || e).split('\n')[0].slice(0, 200);
    console.log(`::warning::weekly-note: ${what} could not be read (${msg})`);
    return null;
  }
}

/**
 * THE HOOK FOR A REAL-PEOPLE COUNT. A later pull request fills this in from
 * whatever rule-1-compliant reader the owner approves; until then it returns
 * null and the note carries no such line. It must return one plain line of
 * aggregate counts, or null — never a number it could not read.
 *
 * @param {{ days: string[] }} ctx  the same 7 UTC days the visitors line reads
 * @returns {Promise<string | null>}
 */
export async function peopleLine(ctx) {
  void ctx; // unread until the reader lands
  return null;
}

async function readVisitors(days) {
  const window = await attempt('the page-view counts', () => readPageviewWindow(days));
  const pageviews =
    window && window.ok
      ? { ok: true, total: PAGEVIEW_SURFACES.reduce((sum, s) => sum + window.surfaces[s].reduce((a, b) => a + b, 0), 0) }
      : { ok: false };
  if (!pageviews.ok) {
    console.log('::warning::weekly-note: the page-view counts could not be read (counters database not configured here, or no answer); the note says so');
  }
  const distinct = [];
  for (const day of days) {
    const r = await attempt(`the distinct-address estimate for ${day}`, () => readDistinctAddressCount(day));
    distinct.push(r && r.ok ? { day, ok: true, count: r.count } : { day, ok: false });
  }
  return { pageviews, distinct };
}

function readHealth() {
  return gh(['issue', 'view', String(HEALTH_ISSUE), '--repo', REPO, '--json', 'body', '--jq', '.body']);
}

function readHealthComments(now) {
  const since = new Date(now.getTime() - NEEDS_MAX_AGE_DAYS * 86_400_000).toISOString();
  return gh([
    'api',
    '--paginate',
    `repos/${REPO}/issues/${HEALTH_ISSUE}/comments?per_page=100&since=${since}`,
    '--jq',
    '.[] | {body, createdAt: .created_at, url: .html_url} | @json',
  ])
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function readNightlyRuns() {
  const runs = JSON.parse(
    gh([
      'run', 'list', '--repo', REPO, '--workflow', 'sync-bills.yml', '--event', 'schedule',
      '--limit', '20', '--json', 'conclusion,status,createdAt',
    ])
  );
  return runs.filter((r) => r.status === 'completed');
}

function readCandidates() {
  const issues = JSON.parse(
    gh([
      'issue', 'list', '--repo', REPO, '--label', 'moment-candidate', '--state', 'open',
      '--limit', '500', '--json', 'number,title,createdAt',
    ])
  );
  // Name each by its bill, from the committed corpus, so the note says
  // "Bipartisan American Affordability and Jobs Act of 2026", not
  // "hr-2347-119". A corpus that will not read leaves the issue titles.
  let byId = new Map();
  try {
    const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
    byId = new Map(bills.map((b) => [b.full_identifier, b.short_title || b.title || null]));
  } catch {
    console.log('::warning::weekly-note: data/bills.json could not be read; candidates keep their issue titles');
  }
  return issues.map((i) => {
    const slug = /([a-z]+-\d+-\d+)\s*$/i.exec(i.title)?.[1]?.toLowerCase();
    return { ...i, billTitle: (slug && byId.get(slug)) || null };
  });
}

export async function buildNote(now = new Date()) {
  const days = trailingWindowDays(now, 7); // yesterday (UTC) back to day-7
  const health = await attempt(`#${HEALTH_ISSUE}'s body`, readHealth);
  const comments = await attempt(`#${HEALTH_ISSUE}'s recent comments`, () => readHealthComments(now));
  const visitors = await readVisitors(days);
  const people = await attempt('the real-people count', () => peopleLine({ days }));
  const runs = await attempt('the nightly run history', readNightlyRuns);
  const candidates = await attempt('the open Big Question candidates', readCandidates);
  return {
    title: noteTitle(now),
    body: noteBody({
      needs: pickNeeds({ body: health, comments, now }),
      visitors: visitorsLine(visitors),
      people,
      nightly: nightlyLine(runs),
      candidates: candidatesLine(candidates),
      spend: spendLine(health),
    }),
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { title, body } = await buildNote();

  if (dryRun) {
    console.log(`--dry-run: nothing was created, closed or labeled.\n\n# ${title}\n\n${body}`);
    return;
  }

  const file = join(mkdtempSync(join(tmpdir(), 'weekly-note-')), 'body.md');
  writeFileSync(file, body, 'utf8');

  gh(['label', 'create', NOTE_LABEL, '--repo', REPO, '--color', '0E8A16', '--force', '--description', "The owner's weekly note"]);
  const url = gh([
    'issue', 'create', '--repo', REPO, '--title', title, '--label', NOTE_LABEL,
    '--assignee', NOTE_ASSIGNEE, '--body-file', file,
  ]).trim();
  const number = Number(/\/issues\/(\d+)\s*$/.exec(url)?.[1]);
  if (!Number.isInteger(number)) throw new Error(`could not read the new issue's number from "${url}"`);
  console.log(`weekly note opened: ${url}`);

  // Close last week's note (and any older one left open), never this one.
  const open = JSON.parse(
    gh(['issue', 'list', '--repo', REPO, '--label', NOTE_LABEL, '--state', 'open', '--limit', '50', '--json', 'number'])
  );
  for (const { number: old } of open) {
    if (old === number) continue;
    gh(['issue', 'close', String(old), '--repo', REPO, '--reason', 'completed']);
    console.log(`closed the previous note #${old}`);
  }
}

if (/(^|\/)weekly-note\.mjs$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    console.error(`::error::weekly-note: ${String(e?.message || e).split('\n')[0]}`);
    process.exit(1);
  });
}
