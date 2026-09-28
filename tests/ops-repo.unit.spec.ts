import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPS_REPO,
  OPS_TOKEN_ENV,
  PUBLIC_REPO,
  issueRefFromOps,
  opsDestination,
  opsGhEnv,
  publicGhEnv,
  withheldSummary,
  writeJobSummary,
} from '../lib/ops-repo.mjs';
import { SEEDED_PAGEVIEWS, SEEDED_SCRIPT_GENERATIONS } from './fixtures/daily-metrics-upstash';

/*
 * THE PRIVATE OPS TRACKER (2026-09-28). The daily metrics digest, its spike
 * and decline alerts, and the standing pipeline-health issue carry traffic
 * numbers and the day's spend estimate, so they post to cm2489/oravan-ops —
 * and with no token for it they post NOWHERE, never back to the public repo.
 *
 * Three layers, each pinned here:
 *   1. lib/ops-repo.mjs — the destination, the two gh environments, the
 *      number-free withheld notice.
 *   2. scripts/daily-metrics.mjs, RUN FOR REAL in a child process with a fake
 *      `gh` on PATH that records every call (argv, which token it ran under,
 *      the body it was handed) and the in-process Upstash mock preloaded
 *      (tests/fixtures/daily-metrics-upstash.ts). No network, no real token.
 *   3. .github/workflows/daily-metrics.yml — its setup step, extracted and run
 *      under bash against the same fake `gh`, and its permissions/env as text.
 */

const ROOT = process.cwd();
const WORKFLOW = join(ROOT, '.github/workflows/daily-metrics.yml');
const OPS_CANARY = 'ops-token-canary';
const PUBLIC_CANARY = 'public-token-canary';

/** gh verbs that change something. Anything else this job runs is a read. */
const WRITE_VERBS = new Set(['create', 'comment', 'edit', 'close', 'pin', 'delete', 'reopen', 'lock', 'transfer']);

type GhCall = {
  args: string[];
  repo: string | null;
  GH_TOKEN: string | null;
  GITHUB_TOKEN: string | null;
  body: string | null;
};

/**
 * A fake `gh` (plain node, CommonJS) that logs one JSON line per call and
 * answers with the smallest output each caller parses: `[]` for lists, an
 * empty comment list for `issue view`, an issue URL for `issue create`, and
 * nothing for the other writes. `--jq` callers (the workflow's bash) get an
 * empty string, which is what a real jq filter over an empty list prints.
 */
function fakeGh(): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ops-repo-gh-'));
  const log = join(dir, 'calls.jsonl');
  const script = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const bodyFile = at('--body-file');
const repo = at('--repo');
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({
  args, repo,
  GH_TOKEN: process.env.GH_TOKEN ?? null,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
  body: bodyFile ? readFileSync(bodyFile, 'utf8') : null,
}) + '\\n');
const [noun, verb] = args;
let out = '[]';
if (args.includes('--jq')) out = '';
else if (noun === 'issue' && verb === 'view') out = '{"comments":[]}';
else if (noun === 'issue' && verb === 'create') out = 'https://github.com/' + repo + '/issues/7';
else if (['comment', 'edit', 'close', 'pin'].includes(verb) || noun === 'label') out = '';
else if (noun === 'run' && verb === 'view') out = '';
process.stdout.write(out + '\\n');
`;
  writeFileSync(join(dir, 'gh'), script, 'utf8');
  chmodSync(join(dir, 'gh'), 0o755);
  return { bin: dir, log };
}

function readCalls(log: string): GhCall[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GhCall);
}

const isWrite = (c: GhCall) => WRITE_VERBS.has(c.args[1]) || c.args[0] === 'label';

/** Strip the two repo names (they contain digits) and ask whether any digit is left. */
const hasFigure = (s: string) => /\d/.test(s.split(OPS_REPO).join('').split(PUBLIC_REPO).join(''));

/** A minimal environment: never the test runner's own, which could hold a real token. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    ...extra,
  };
}

/** Run scripts/daily-metrics.mjs the way the workflow does (tsx), async so nothing blocks. */
function runDigest(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--import', './tests/fixtures/daily-metrics-upstash.ts', 'scripts/daily-metrics.mjs'],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('close', (code: number | null) => resolve({ code, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// 1 · lib/ops-repo.mjs
// ---------------------------------------------------------------------------

test.describe('the destination', () => {
  test('the ops tracker is cm2489/oravan-ops, and it is not the public repo', () => {
    expect(OPS_REPO).toBe('cm2489/oravan-ops');
    expect(PUBLIC_REPO).toBe('cm2489/oravan');
    expect(OPS_REPO).not.toBe(PUBLIC_REPO);
    expect(OPS_TOKEN_ENV).toBe('OPS_ISSUES_TOKEN');
  });

  test('no token: not ok, and no repo to post to at all', () => {
    for (const env of [{}, { OPS_ISSUES_TOKEN: '' }, { OPS_ISSUES_TOKEN: '   \n' }]) {
      const d = opsDestination(env);
      expect(d.ok).toBe(false);
      expect(d).not.toHaveProperty('repo');
      expect(d).not.toHaveProperty('token');
      if (!d.ok) expect(d.reason).toContain(OPS_TOKEN_ENV);
    }
  });

  test('NO FALLBACK: nothing in the environment can point it at the public repo', () => {
    // Every variable that names a repo somewhere in this codebase, set to the
    // public one. With no ops token the answer is still "nowhere"...
    const hostile = {
      GITHUB_REPOSITORY: PUBLIC_REPO,
      HEALTH_REPO: PUBLIC_REPO,
      DISPATCH_REPO: PUBLIC_REPO,
      OPS_REPO: PUBLIC_REPO,
      GH_REPO: PUBLIC_REPO,
      GITHUB_TOKEN: PUBLIC_CANARY,
      GH_TOKEN: PUBLIC_CANARY,
    };
    const none = opsDestination(hostile);
    expect(none.ok).toBe(false);
    expect(JSON.stringify(none)).not.toContain(PUBLIC_CANARY);
    // ...and with one, it is still the ops repo, under the ops token.
    const armed = opsDestination({ ...hostile, OPS_ISSUES_TOKEN: OPS_CANARY });
    expect(armed).toEqual({ ok: true, repo: OPS_REPO, token: OPS_CANARY });
  });

  test('the ops env hands gh the ops token; the public env strips it so GITHUB_TOKEN is used', () => {
    const base = { PATH: '/bin', GITHUB_TOKEN: PUBLIC_CANARY, GH_TOKEN: 'stray' };
    expect(opsGhEnv(base, OPS_CANARY)).toEqual({ PATH: '/bin', GITHUB_TOKEN: PUBLIC_CANARY, GH_TOKEN: OPS_CANARY });
    const pub = publicGhEnv(base);
    expect(pub).toEqual({ PATH: '/bin', GITHUB_TOKEN: PUBLIC_CANARY });
    expect(pub).not.toHaveProperty('GH_TOKEN');
    // Neither mutates the environment it was given.
    expect(base.GH_TOKEN).toBe('stray');
  });

  test('an issue reference reads correctly from inside the ops repo', () => {
    expect(issueRefFromOps(OPS_REPO, 12)).toBe('#12');
    expect(issueRefFromOps(PUBLIC_REPO, 328)).toBe('cm2489/oravan#328');
  });

  test('the withheld notice says what and how to arm it, and carries no figure', () => {
    const md = withheldSummary({ what: 'Daily metrics digest', reason: opsDestination({}).ok ? '' : 'no token' });
    expect(md).toContain('Daily metrics digest: not posted');
    expect(md).toContain(OPS_TOKEN_ENV);
    expect(md).toContain(OPS_REPO);
    expect(md).toMatch(/Issues: read and write/);
    expect(hasFigure(md)).toBe(false);
  });

  test('writeJobSummary appends under Actions and is a no-op outside it', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ops-repo-summary-')), 'summary.md');
    writeFileSync(file, 'earlier step\n', 'utf8');
    expect(writeJobSummary('### hello', { GITHUB_STEP_SUMMARY: file })).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('earlier step\n### hello\n');
    expect(writeJobSummary('### hello', {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2 · scripts/daily-metrics.mjs, run for real
// ---------------------------------------------------------------------------

test.describe('scripts/daily-metrics.mjs', () => {
  test.describe.configure({ timeout: 120_000 });

  const baseEnv = (gh: { bin: string; log: string }, summary: string) =>
    childEnv({
      PATH: `${gh.bin}:${process.env.PATH ?? ''}`,
      FAKE_GH_LOG: gh.log,
      GITHUB_STEP_SUMMARY: summary,
      UPSTASH_COUNTERS_REST_URL: 'https://counters.mock.test',
      UPSTASH_COUNTERS_REST_TOKEN: 'test-counters-token',
      VERCEL_ENV: 'production',
      GITHUB_TOKEN: PUBLIC_CANARY,
    });

  test('NO OPS TOKEN: posts nowhere — no gh call at all — warns, and the summary shows no figure', async () => {
    const gh = fakeGh();
    const summary = join(gh.bin, 'summary.md');
    // DIGEST_ISSUE_NUMBER is empty exactly as the workflow's skipped setup
    // step leaves it.
    const r = await runDigest({ ...baseEnv(gh, summary), DIGEST_ISSUE_NUMBER: '' });

    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('::warning::daily metrics digest NOT POSTED');
    // Not one gh invocation: nothing was posted to the ops repo, and — the
    // point — nothing fell back to the public one.
    expect(readCalls(gh.log)).toEqual([]);
    const md = readFileSync(summary, 'utf8');
    expect(md).toContain('not posted');
    expect(md).toContain(OPS_TOKEN_ENV);
    expect(hasFigure(md)).toBe(false);
    expect(r.stdout).not.toContain(SEEDED_PAGEVIEWS);
    expect(r.stdout).not.toContain(SEEDED_SCRIPT_GENERATIONS);
  });

  test('ARMED: every write goes to the ops repo under the ops token; the public repo is only read', async () => {
    const gh = fakeGh();
    const summary = join(gh.bin, 'summary.md');
    const r = await runDigest({ ...baseEnv(gh, summary), OPS_ISSUES_TOKEN: OPS_CANARY, DIGEST_ISSUE_NUMBER: '5' });
    expect(r.code, r.stderr).toBe(0);

    const calls = readCalls(gh.log);
    expect(calls.length).toBeGreaterThan(0);
    // Every call names its repo — none relies on the checkout's own remote.
    for (const c of calls) expect(c.repo, JSON.stringify(c.args)).not.toBeNull();

    const writes = calls.filter(isWrite);
    expect(writes.length).toBeGreaterThan(0);
    for (const c of writes) {
      expect(c.repo, JSON.stringify(c.args)).toBe(OPS_REPO);
      expect(c.GH_TOKEN).toBe(OPS_CANARY);
    }

    // The public repo: reads only, and under the runner's token, never the PAT.
    const publicCalls = calls.filter((c) => c.repo === PUBLIC_REPO);
    expect(publicCalls.length).toBeGreaterThan(0);
    for (const c of publicCalls) {
      expect(isWrite(c), JSON.stringify(c.args)).toBe(false);
      expect(c.GH_TOKEN).toBeNull();
      expect(c.GITHUB_TOKEN).toBe(PUBLIC_CANARY);
    }
    // Nothing else exists: every call is one of the two repos.
    expect(calls.every((c) => c.repo === OPS_REPO || c.repo === PUBLIC_REPO)).toBe(true);

    // The figures went to the private tracker — the digest comment on #5, and
    // a spike issue for the seeded script-generation jump...
    const digest = writes.find((c) => c.args[0] === 'issue' && c.args[1] === 'comment' && c.args[2] === '5');
    expect(digest?.body).toContain(SEEDED_PAGEVIEWS);
    const spike = writes.find((c) => c.args[0] === 'issue' && c.args[1] === 'create' && c.args.includes('traffic-spike'));
    expect(spike?.body).toContain(SEEDED_SCRIPT_GENERATIONS);
    // ...and not into the public run log, whose closing line says where they are.
    expect(r.stdout).not.toContain(SEEDED_PAGEVIEWS);
    expect(r.stdout).not.toContain(SEEDED_SCRIPT_GENERATIONS);
    expect(r.stdout).toContain(`to the private ops tracker (${OPS_REPO})`);
    // Armed runs write no withheld notice.
    expect(existsSync(summary)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3 · .github/workflows/daily-metrics.yml
// ---------------------------------------------------------------------------

const yml = () => readFileSync(WORKFLOW, 'utf8');
const withoutComments = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/** One step's text, from its `- name:` to the next step. */
function stepText(nameStart: string): string {
  const text = yml();
  const start = text.indexOf(`- name: ${nameStart}`);
  expect(start, `workflow step "${nameStart}" not found`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n      - name: ');
  return rest.slice(0, end === -1 ? undefined : end);
}

/** The `run: |` block of a step, dedented, ready for bash. */
function runBlock(step: string): string {
  const lines = step.split('\n');
  const at = lines.findIndex((l) => /^\s*run: \|\s*$/.test(l));
  expect(at).toBeGreaterThan(-1);
  const indent = (lines[at + 1].match(/^ */) ?? [''])[0].length;
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== '' && (l.match(/^ */) ?? [''])[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

test.describe('daily-metrics.yml', () => {
  const SETUP = 'Ensure labels + pinned digest issue exist in the ops tracker';
  const COMPUTE = 'Compute + post digest';

  function runSetup(ghToken: string) {
    const gh = fakeGh();
    const output = join(gh.bin, 'output.txt');
    writeFileSync(output, '', 'utf8');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', runBlock(stepText(SETUP))], {
      env: childEnv({
        PATH: `${gh.bin}:${process.env.PATH ?? ''}`,
        FAKE_GH_LOG: gh.log,
        GITHUB_OUTPUT: output,
        GH_TOKEN: ghToken,
        OPS_REPO: 'cm2489/oravan-ops',
        GITHUB_TOKEN: PUBLIC_CANARY,
      }),
      encoding: 'utf8',
    });
    return { r, calls: readCalls(gh.log), output: readFileSync(output, 'utf8') };
  }

  test('the setup step takes its repo and token from the ops tracker, never this repo', () => {
    const step = stepText(SETUP);
    expect(step).toContain('GH_TOKEN: ${{ secrets.OPS_ISSUES_TOKEN }}');
    expect(step).toMatch(/OPS_REPO: cm2489\/oravan-ops\s*$/m);
    expect(step).not.toContain('secrets.GITHUB_TOKEN');
    // Every gh command in it names the ops repo.
    const ghLines = withoutComments(runBlock(step))
      .split('\n')
      .filter((l) => /\bgh (label|issue|api|run|pr|repo)\b/.test(l));
    expect(ghLines.length).toBeGreaterThan(0);
    for (const l of ghLines) expect(l, l).toContain('--repo "$OPS_REPO"');
  });

  test('setup, NO TOKEN: exits 0, makes no gh call, leaves the issue number empty', () => {
    const { r, calls, output } = runSetup('');
    expect(r.status, r.stderr).toBe(0);
    expect(calls).toEqual([]);
    expect(output).toBe('issue_num=\n');
  });

  test('setup, ARMED: every gh call targets the ops repo, and it finds or files the pinned digest', () => {
    const { r, calls, output } = runSetup(OPS_CANARY);
    expect(r.status, r.stderr).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.repo, JSON.stringify(c.args)).toBe(OPS_REPO);
      expect(c.GH_TOKEN).toBe(OPS_CANARY);
    }
    // The fake's issue list is empty, so the digest issue is created, then pinned.
    expect(calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'create' && c.args.includes('metrics'))).toBe(true);
    expect(calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'pin')).toBe(true);
    expect(output).toBe('issue_num=7\n');
    // The labels the feedback route applies exist in the ops tracker too.
    const labels = calls.filter((c) => c.args[0] === 'label').map((c) => c.args[2]);
    for (const l of ['metrics', 'traffic-spike', 'traffic-decline', 'pipeline-health', 'beta-feedback', 'feature', 'partnership', 'other']) {
      expect(labels).toContain(l);
    }
  });

  test('the compute step gets both tokens, and never sets GH_TOKEN (it would hijack the public reads)', () => {
    const step = stepText(COMPUTE);
    expect(step).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(step).toContain('OPS_ISSUES_TOKEN: ${{ secrets.OPS_ISSUES_TOKEN }}');
    expect(withoutComments(step)).not.toMatch(/^\s*GH_TOKEN:/m);
  });

  test("the runner's own token can only READ issues here — a write to this repo would be refused", () => {
    const perms = withoutComments(yml());
    expect(perms).toMatch(/^\s{2}issues: read\s*$/m);
    expect(perms).not.toMatch(/issues: write/);
  });

  test('no command line in the workflow names the public repo', () => {
    // Comments may explain the move; no executable line may target this repo.
    const live = withoutComments(yml());
    expect(live).not.toMatch(/cm2489\/oravan(?!-ops)/);
  });
});
