import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ISSUE_LABEL,
  PLACEMENT,
  formatIssueBody,
  run,
  sweepFloorAction,
  verdictFor,
} from '../scripts/check-scaffold-corpus.mjs';
import { NEVER_CLOSE_LABELS } from '../lib/traffic-metrics.mjs';

/*
 * scripts/check-scaffold-corpus.mjs — the Moment-scaffold floor-action sweep
 * that moved OUT of the PR suite and into the nightly (the 2026-09-27 audit,
 * SY-47).
 *
 * EVERY INPUT HERE IS A FIXTURE. That is the whole point of the move: the
 * sweep over data/bills.json reddened main for four days on sentences
 * Congress wrote, so it now runs where the corpus changes (sync-bills.yml)
 * and files an issue. What stays with PRs is what tests CODE — the sweep's
 * classification logic and its verdict contract, below — plus the
 * floorActionInRecord fixtures in tests/moment-scaffold.unit.spec.ts.
 *
 * The fixture sentences are real record shapes, copied from the fixtures
 * tests/moment-scaffold.unit.spec.ts already pins.
 */

const bill = (slug: string, status: string, last_action_text: string | null, status_basis_text?: string) => ({
  full_identifier: slug,
  status,
  last_action_text,
  ...(status_basis_text ? { status_basis_text } : {}),
});

const MOTION_TO_PROCEED = 'Motion to proceed to consideration of measure made in Senate.';
const CONSIDERED = 'Considered by Senate. (consideration: CR S4851)';
const ADOPTED_RULE = 'Rule H. Res. 988 passed House.';
const PLACED = 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 501.';
const DISCHARGE_FILED =
  'Motion to Discharge Committee filed by Mr. Kiley (CA). Petition No: 119-21. (<a href="https://clerk.house.gov/DischargePetition/2026051221">Discharge petition</a> text with signatures.)';
const SENATE_DEFEAT = 'Failed of passage in Senate by Yea-Nay Vote. 45 - 52. Record Vote Number: 210.';
const RECONSIDER = 'Motion to reconsider laid on the table Agreed to without objection.';
const HOUSE_DEFEAT =
  'Failed of passage/not agreed to in House On passage Failed by the Yeas and Nays: 209 - 215 (Roll no. 19).';
const NOVEL = 'The Senate did a thing with this measure that no one has written a matcher for yet.';

/** A corpus the matcher reads completely — every exemption represented once. */
const CLEAN = [
  bill('s-1-119', 'floor_vote', MOTION_TO_PROCEED),
  bill('s-2-119', 'floor_vote', CONSIDERED),
  bill('hr-3-119', 'floor_vote', ADOPTED_RULE),
  bill('s-11-119', 'floor_vote', 'Measure laid before Senate by motion.'),
  bill('s-4-119', 'floor_vote', PLACED), // placement: tier0_floor, never floor action
  bill('hr-5-119', 'floor_vote', DISCHARGE_FILED), // claim-free exemption
  bill('sjres-6-119', 'floor_vote', SENATE_DEFEAT), // settled exemption
  bill('hr-7-119', 'floor_vote', RECONSIDER, HOUSE_DEFEAT), // settled, read through its basis
  bill('hr-8-119', 'committee', MOTION_TO_PROCEED), // off the floor: never floor action
  bill('hr-9-119', 'introduced', null),
];

test.describe('sweepFloorAction — the classification the retired CI test made', () => {
  test('a corpus the matcher reads completely is clean, with every bucket counted', () => {
    const report = sweepFloorAction(CLEAN);
    expect(report.missed).toEqual([]);
    expect(report.overfired).toEqual([]);
    expect(report.problems).toEqual([]);
    expect(report.counts).toEqual({ floorVote: 8, activityOnly: 4, claimFree: 1, settledOutcome: 2 });
    expect(verdictFor(report)).toBe('clean');
  });

  test('a floor_vote sentence no pattern reads is MISSED — the finding that reddened main twice', () => {
    const report = sweepFloorAction([...CLEAN, bill('s-10-119', 'floor_vote', NOVEL)]);
    expect(report.missed).toEqual([{ slug: 's-10-119', status: 'floor_vote', text: NOVEL }]);
    expect(verdictFor(report)).toBe('findings');
  });

  test('the sentence READ is the status basis, not the bare notice over it (2026-09-25)', () => {
    // The H.R. 2262 shape: the notice alone names no floor action, and reading
    // it would call a House defeat "missed". Read through its basis it is a
    // settled outcome, which is what the record says.
    const report = sweepFloorAction([bill('hr-2262-119', 'floor_vote', RECONSIDER, HOUSE_DEFEAT)]);
    expect(report.missed).toEqual([]);
    expect(report.counts.settledOutcome).toBe(1);
  });

  test('a placement is judged on last_action_text, and is never floor action', () => {
    expect(PLACEMENT.test(PLACED)).toBe(true);
    const report = sweepFloorAction([bill('s-4-119', 'floor_vote', PLACED)]);
    expect(report.counts.activityOnly).toBe(0);
    expect(report.overfired).toEqual([]);
  });

  test('an empty floor-activity population is a finding, never a vacuous pass', () => {
    const report = sweepFloorAction([bill('s-4-119', 'floor_vote', PLACED), bill('hr-8-119', 'committee', NOVEL)]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('proved nothing');
    expect(verdictFor(report)).toBe('findings');
  });

  test('exemptions that swallow the population are a finding — a carve-out, never the rule', () => {
    const report = sweepFloorAction([
      bill('s-1-119', 'floor_vote', MOTION_TO_PROCEED),
      bill('hr-5-119', 'floor_vote', DISCHARGE_FILED),
      bill('sjres-6-119', 'floor_vote', SENATE_DEFEAT),
    ]);
    expect(report.counts).toMatchObject({ activityOnly: 1, claimFree: 1, settledOutcome: 1 });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('exemptions');
  });
});

test.describe('the issue body carries the record, not a paraphrase of it', () => {
  test('it quotes each missed sentence verbatim, names the file to extend, and says what it does NOT cost', () => {
    const report = sweepFloorAction([...CLEAN, bill('s-10-119', 'floor_vote', NOVEL)]);
    const body = formatIssueBody(report, '2026-09-27');
    expect(body).toContain('2026-09-27');
    expect(body).toContain('**s-10-119**');
    expect(body).toContain(`> ${NOVEL}`);
    expect(body).toContain('FLOOR_ACTION_PATTERNS');
    expect(body).toContain('No page reads this matcher');
    expect(body).toContain('Swept: 9 `floor_vote` records');
  });
});

test.describe('run() — the verdict contract sync-bills.yml reads', () => {
  const withCorpus = (bills: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'scaffold-corpus-'));
    const billsPath = join(dir, 'bills.json');
    writeFileSync(billsPath, typeof bills === 'string' ? bills : JSON.stringify(bills));
    return { dir, billsPath };
  };

  test('clean: exit 0, verdict clean, and no report file left for the issue step to post', () => {
    const { dir, billsPath } = withCorpus(CLEAN);
    const out = join(dir, 'GITHUB_OUTPUT');
    writeFileSync(out, '');
    const prev = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = out;
    try {
      const result = run({ billsPath, outDir: dir });
      expect(result).toMatchObject({ verdict: 'clean', exitCode: 0 });
      expect(existsSync(result.mdPath)).toBe(false);
      expect(readFileSync(out, 'utf8')).toBe('verdict=clean\n');
    } finally {
      if (prev === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = prev;
    }
  });

  test('findings: exit 1 (soft — the workflow step is continue-on-error), verdict findings, body written', () => {
    const { dir, billsPath } = withCorpus([...CLEAN, bill('s-10-119', 'floor_vote', NOVEL)]);
    const realError = console.error;
    console.error = () => {};
    try {
      const result = run({ billsPath, outDir: dir, now: new Date('2026-09-27T15:00:00Z') });
      expect(result).toMatchObject({ verdict: 'findings', exitCode: 1 });
      expect(readFileSync(result.mdPath, 'utf8')).toContain(NOVEL);
    } finally {
      console.error = realError;
    }
  });

  test('a corpus that will not parse is an ERROR with its own body — never clean, and never silent', () => {
    const { dir, billsPath } = withCorpus('{ not json');
    const realError = console.error;
    console.error = () => {};
    try {
      const result = run({ billsPath, outDir: dir, now: new Date('2026-09-27T15:00:00Z') });
      expect(result).toMatchObject({ verdict: 'error', exitCode: 2 });
      expect(readFileSync(result.mdPath, 'utf8')).toContain('could not run');
    } finally {
      console.error = realError;
    }
  });

  test('the label the workflow files under is the one the digest hygiene never closes', () => {
    expect(ISSUE_LABEL).toBe('scaffold-corpus');
    expect(NEVER_CLOSE_LABELS).toContain(ISSUE_LABEL);
  });
});
