// The Moment-scaffold floor-action tripwire, at the layer where the corpus
// changes (the 2026-09-27 audit, SY-47).
//
// WHAT THIS IS: the totality sweep over `floorActionInRecord`
// (scripts/moment-scaffold.mjs) that used to be the test "the floor-action
// vocabulary is total over the corpus it is for, and fires nowhere else" in
// tests/moment-scaffold.unit.spec.ts. Same two directions, same exemptions,
// same guards:
//   - TOTAL: every `floor_vote` bill that is not a calendar placement, not a
//     shape read and judged claim-free (floorMakesNoClaim) and not a settled
//     floor outcome (FLOOR_SETTLED) must be read as floor action;
//   - NOWHERE ELSE: no placement, no claim-free sentence and no bill off the
//     floor may be;
//   - the population must not be empty, and the two carve-outs must never
//     swallow it.
//
// WHY IT MOVED: it tests DATA, not code. Congress writes a new sentence, the
// nightly sync derives `floor_vote` from it, and the sweep goes red — on main
// and on every unrelated PR, until someone extends the matcher. That is what
// happened 2026-09-22..25 (H.R. 4366, then H.R. 2262): main's CI stayed red
// for days, and the standing merge grant requires green. The owner
// ruled the same thing about the journey-corpus sweep on 2026-08-04; this
// file follows scripts/check-journey-corpus.mjs, and the fixtures that test
// the matcher's CODE stay in tests/moment-scaffold.unit.spec.ts with PRs.
//
// WHAT A FINDING COSTS: no page reads this matcher. It drafts the
// qualifying signal in a moment-watch scaffold (which scripts/moment-approve.mjs
// can later publish). A MISSED sentence leaves that field empty and says so —
// the fail-closed direction, and the direction of both reds that moved this
// sweep here (H.R. 4366 and H.R. 2262 were each read as NOT floor action). A
// sentence read where it should not be would draft a signal the record does
// not support; the matcher's own guards make that unreachable today, and the
// issue body says to read it before the next approval if it ever appears.
// Either way the night's data is not the problem, so a finding files a
// labeled `scaffold-corpus` issue and the night commits. There is NO hard
// verdict here, unlike the journey sweep's vacuity floor — the corpus-size
// floor that proves the sync did its job already runs, hard, in the journey
// step before this one; an empty population HERE is a finding about the
// matcher, and it is filed like one.
//
// VERDICT — written to $GITHUB_OUTPUT as `verdict=`; sync-bills.yml files
// the issue on anything but `clean`, so a sweep that died before writing a
// verdict can never read as an all-clear:
//   clean     nothing found                                   exit 0
//   findings  a sentence to read, or a population problem     exit 1
//   error     the sweep could not run                         exit 2
//
// Plain node: every module it reads is .mjs. Zero network.
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLOOR_SETTLED, floorMakesNoClaim, statusBasisText } from '../lib/floor-text.mjs';
import { floorActionInRecord } from './moment-scaffold.mjs';

/** The placement shape, exactly as the retired test read it (it mirrors
 *  scripts/moment-candidates.mjs's isOnFloorCalendar gate, which is what sets
 *  `floorCalendar` on a real candidate). */
export const PLACEMENT = /placed on (?:the )?(senate legislative|union|house|senate)\s+calendar/i;

export const ISSUE_LABEL = 'scaffold-corpus';

/**
 * The sweep. Pure: bills in, classification out.
 *
 * WHICH SENTENCES. The placement check reads `last_action_text` (a basis sits
 * only behind a reconsider or message notice, which follow a vote, never a
 * placement); the floor-action reading reads statusBasisText — the sentence
 * the status was derived FROM — for the reason floorActionInRecord's own
 * header gives (2026-09-25: six House defeats behind a reconsider notice).
 *
 * @param {Array<Record<string, any>>} bills
 */
export function sweepFloorAction(bills) {
  const counts = { floorVote: 0, activityOnly: 0, claimFree: 0, settledOutcome: 0 };
  /** floor activity the matcher does not read — the vocabulary is not total */
  const missed = [];
  /** the matcher reads floor action where the record says something else */
  const overfired = [];

  for (const b of bills) {
    const text = statusBasisText(b);
    const placement = PLACEMENT.test(b.last_action_text ?? '');
    const onFloor = b.status === 'floor_vote';
    if (onFloor) counts.floorVote++;
    const derived = floorActionInRecord({ status: b.status, floorCalendar: onFloor && placement }, text);
    const row = { slug: b.full_identifier, status: b.status, text: text ?? '' };

    // Exemption 1 (2026-09-18, issue #241): read and judged claim-free. It
    // must derive NOTHING — the stricter direction.
    if (onFloor && !placement && floorMakesNoClaim(text)) {
      counts.claimFree++;
      if (derived) overfired.push({ ...row, why: 'a shape judged claim-free (floorMakesNoClaim) must derive nothing' });
      continue;
    }
    // Exemption 2 (2026-09-19): a settled floor outcome that matches no
    // activity shape derives nothing, and nothing is the honest answer.
    if (onFloor && !placement && !derived && FLOOR_SETTLED.test(text ?? '')) {
      counts.settledOutcome++;
      continue;
    }
    if (onFloor && !placement) {
      counts.activityOnly++;
      if (!derived) missed.push(row);
    } else if (derived) {
      overfired.push({
        ...row,
        why: placement ? 'a calendar placement is tier0_floor, never floor action' : 'the bill is not at floor_vote',
      });
    }
  }

  const problems = [];
  // Guards the guard: an empty population makes the totality claim vacuous.
  if (counts.activityOnly === 0) {
    problems.push(
      `No \`floor_vote\` bill tonight is floor ACTIVITY (every one is a placement, claim-free, or settled) — the totality check proved nothing. ${counts.floorVote} \`floor_vote\` records were swept.`
    );
  }
  // The exemptions are a carve-out, never the rule.
  if (counts.activityOnly > 0 && counts.claimFree + counts.settledOutcome >= counts.activityOnly) {
    problems.push(
      `The two exemptions (claim-free ${counts.claimFree}, settled ${counts.settledOutcome}) now cover at least as many bills as the population they carve out of (${counts.activityOnly}) — check that neither has started swallowing real floor action.`
    );
  }

  return { counts, missed, overfired, problems };
}

/** clean | findings — `error` is decided by the caller, which is the only
 *  place that knows the sweep could not run. */
export function verdictFor(report) {
  return report.missed.length || report.overfired.length || report.problems.length ? 'findings' : 'clean';
}

/** The issue body — the sentences themselves, so the fix starts from the record. */
export function formatIssueBody(report, date) {
  const lines = [
    `The nightly sync of ${date} ran the Moment-scaffold floor-action sweep (\`scripts/check-scaffold-corpus.mjs\`) and found something to read.`,
    '',
    '**No page reads this matcher.** `floorActionInRecord` drafts the qualifying signal in a `moment-watch`',
    'scaffold. A sentence it misses leaves that field empty and says so, which is the safe direction. That is',
    'why this is an issue and not a failed night — and why it no longer reds CI on unrelated PRs.',
    '',
  ];
  if (report.missed.length) {
    lines.push('### Floor activity the matcher does not read');
    for (const b of report.missed) {
      lines.push(`- **${b.slug}** — \`floor_vote\`, not a placement, not claim-free, not settled:`, `  > ${b.text}`);
    }
    lines.push('');
  }
  if (report.overfired.length) {
    lines.push('### Floor action read where the record says otherwise');
    lines.push(
      '_The unsafe direction: a scaffold for one of these would draft a qualifying signal the record does not support. Read these before approving the next Moment._'
    );
    for (const b of report.overfired) {
      lines.push(`- **${b.slug}** (\`${b.status}\`) — ${b.why}:`, `  > ${b.text}`);
    }
    lines.push('');
  }
  if (report.problems.length) {
    lines.push('### The sweep itself');
    for (const p of report.problems) lines.push(`- ${p}`);
    lines.push('');
  }
  const c = report.counts;
  lines.push(
    `Swept: ${c.floorVote} \`floor_vote\` records — ${c.activityOnly} floor activity, ${c.claimFree} claim-free, ${c.settledOutcome} settled outcomes.`,
    '',
    'Fix a missed sentence by extending `FLOOR_ACTION_PATTERNS` in `scripts/moment-scaffold.mjs` (or, if the',
    'sentence is read and deliberately claim-free, `floorMakesNoClaim` in `lib/floor-text.mjs`), with a fixture',
    'in `tests/moment-scaffold.unit.spec.ts`. Close this issue when the sweep comes back clean.'
  );
  return lines.join('\n');
}

function setOutput(verdict) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${verdict}\n`);
}

/**
 * Read the corpus, sweep, write the issue body, report the verdict. Exported
 * so tests/scaffold-corpus.unit.spec.ts can drive the whole contract over a
 * FIXTURE corpus — never the real one, which is the point of this file.
 *
 * @param {{ billsPath?: string, outDir?: string, now?: Date }} [opts]
 * @returns {{ verdict: 'clean'|'findings'|'error', exitCode: 0|1|2, mdPath: string }}
 */
export function run({ billsPath = 'data/bills.json', outDir = process.env.RUNNER_TEMP || process.cwd(), now = new Date() } = {}) {
  const mdPath = join(outDir, 'scaffold-corpus-report.md');
  // Never let a stale report from a previous run be mistaken for this one's.
  rmSync(mdPath, { force: true });

  let report;
  try {
    const bills = JSON.parse(readFileSync(billsPath, 'utf8'));
    if (!Array.isArray(bills)) throw new Error(`${billsPath} is not an array`);
    report = sweepFloorAction(bills);
  } catch (e) {
    console.error(`::error::scaffold-corpus: the sweep could not run (${e.message}) — this is not a clean result`);
    writeFileSync(
      mdPath,
      `The nightly Moment-scaffold floor-action sweep could not run on ${now.toISOString().slice(0, 10)}:\n\n> ${e.message}\n\nThis is not a clean result. Nothing on the site depends on the sweep; the night's data still committed.`
    );
    setOutput('error');
    return { verdict: 'error', exitCode: 2, mdPath };
  }

  const verdict = verdictFor(report);
  const c = report.counts;
  if (verdict === 'clean') {
    console.log(
      `scaffold-corpus clean: ${c.floorVote} floor_vote records — ${c.activityOnly} floor activity all read, ${c.claimFree} claim-free, ${c.settledOutcome} settled`
    );
    setOutput('clean');
    return { verdict, exitCode: 0, mdPath };
  }

  for (const b of report.missed) {
    console.error(`::error::scaffold-corpus: ${b.slug} is floor activity the scaffold does not read: ${b.text}`);
  }
  for (const b of report.overfired) {
    console.error(`::error::scaffold-corpus: ${b.slug} reads as floor action but ${b.why}: ${b.text}`);
  }
  for (const p of report.problems) console.error(`::error::scaffold-corpus: ${p}`);
  writeFileSync(mdPath, formatIssueBody(report, now.toISOString().slice(0, 10)));
  console.error('::error::scaffold-corpus: an issue is being filed; the night\'s data still commits');
  setOutput('findings');
  return { verdict, exitCode: 1, mdPath };
}

// Run when invoked as a script; stay importable for tests. A path match, not
// import.meta — the test runner loads this module through a CommonJS
// transform where import.meta does not exist (same idiom as
// scripts/check-cursor-age.mjs).
if (/(^|\/)check-scaffold-corpus\.mjs$/.test(process.argv[1] ?? '')) {
  process.exit(run().exitCode);
}
