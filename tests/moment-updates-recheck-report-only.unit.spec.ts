import { expect, test } from '@playwright/test';
/*
 * THE SWITCH SHIPS OFF (2026-11-14). With RECHECK_MODE = 'report', the
 * nightly comparison runs in full and writes NOTHING to
 * data/moment-updates.json: it only reports.
 *
 * This runs the REAL collector (scripts/moment-updates.mjs, nightly mode) as
 * a child process, offline, in a temporary folder holding a copy of data/ and
 * messages/, with Congress.gov answered by a stub that serves one list and
 * refuses everything else (no network, no key, no model call). Two nights:
 * the owner's proof (S. 4668's list with the record's "tabled") and a night a
 * guard would refuse. Each must leave data/moment-updates.json byte-identical,
 * enter no write path, and report the rows it would have changed.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECHECK_MODE } from '../lib/moment-updates-recheck.mjs';
import { etDay } from '../lib/moment-updates-gate.mjs';

const REPO = process.cwd();
const FIXTURE = JSON.parse(readFileSync(join(REPO, 'tests/fixtures/congress-actions-s4668.json'), 'utf8')).actions as Record<string, unknown>[];

const STUB = `
import { readFileSync, existsSync } from 'node:fs';
const dir = process.env.STUB_ACTIONS_DIR;
globalThis.fetch = async (input) => {
  const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
  const m = url.pathname.match(/^\\/v3\\/bill\\/(\\d+)\\/([a-z]+)\\/(\\d+)\\/actions$/);
  if (url.host === 'api.congress.gov' && m) {
    const f = dir + '/' + m[2] + '-' + m[3] + '-actions.json';
    if (existsSync(f)) return new Response(readFileSync(f, 'utf8'), { status: 200 });
  }
  return new Response('offline', { status: 404 });
};
const real = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => real(fn, Math.min(Number(ms) || 0, 5), ...a);
`;

function night(actions: Record<string, unknown>[], prepare: (dir: string) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'recheck-report-only-'));
  try {
    cpSync(join(REPO, 'data'), join(dir, 'data'), { recursive: true });
    cpSync(join(REPO, 'messages'), join(dir, 'messages'), { recursive: true });
    rmSync(join(dir, 'data/record-recheck-report.json'), { force: true });
    // A valid one-night accept list for tonight: report-only must not even read it.
    writeFileSync(
      join(dir, 'data/record-recheck-accept.json'),
      JSON.stringify({ accept: [{ night: etDay(Date.now()), ids: ['u_d5eaf6d9', 'u_682cca41'], why: 'A test accept list, which report-only must ignore.' }] }),
    );
    writeFileSync(join(dir, 'stub.mjs'), STUB);
    writeFileSync(
      join(dir, 's-4668-actions.json'),
      JSON.stringify({ actions, pagination: { count: actions.length }, request: { billType: 's', billNumber: '4668', congress: '119' } }),
    );
    prepare(dir);
    const before = readFileSync(join(dir, 'data/moment-updates.json'));
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(GIT_|ANTHROPIC_|GITHUB_STEP_SUMMARY)/.test(k)) delete env[k];
    Object.assign(env, {
      MOMENT_UPDATES_MODE: 'nightly',
      CONGRESS_API_KEY: 'offline-stub',
      STUB_ACTIONS_DIR: dir,
      NODE_OPTIONS: `--import ${join(dir, 'stub.mjs')}`,
    });
    const run = spawnSync(process.execPath, [join(REPO, 'scripts/moment-updates.mjs')], { cwd: dir, env, encoding: 'utf8', timeout: 90_000 });
    const after = readFileSync(join(dir, 'data/moment-updates.json'));
    const reportPath = join(dir, 'data/record-recheck-report.json');
    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
    return { status: run.status, log: `${run.stdout}\n${run.stderr}`, same: before.equals(after), report };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The record as it stands: the fixture, with "withdrawn" read as "tabled". */
const RECORD_NOW = FIXTURE.map((a) =>
  a.text === 'The committee substitute withdrawn by Voice Vote.' ? { ...a, text: 'The committee substitute tabled by Voice Vote.' } : a,
);
/** The same, carrying the House's Oct 5 actions too (data/bills.json's latest action for S. 4668). */
const WITH_LATEST = [
  { actionDate: '2026-10-05', text: 'Held at the desk.', actionCode: 'H15000', sourceSystem: { name: 'House floor actions' } },
  { actionDate: '2026-10-05', text: 'Received in the House.', actionCode: 'H14000', sourceSystem: { name: 'House floor actions' } },
  ...RECORD_NOW,
];

test.describe.configure({ mode: 'serial' });

test('the switch is committed OFF', () => {
  expect(RECHECK_MODE).toBe('report');
});

test("the owner's proof night: data/moment-updates.json is byte-identical, nothing is applied, and both rows are reported", () => {
  const r = night(RECORD_NOW);
  expect(r.status, r.log.slice(-2000)).toBe(0);
  expect(r.same).toBe(true);
  expect(r.log).toContain('record re-check (REPORT ONLY: nothing is written to data/moment-updates.json)');
  expect(r.log).toContain('DONE: no change');
  // No write path entered: nothing applied, nothing followed up.
  expect(r.log).not.toMatch(/REPORT: (corrected|withdrawed|withdrawn|held|reinstated) /);
  expect(r.log).not.toContain('recheck follow-up');
  expect(r.log).not.toContain('accepted for');
  // The report names both of the owner's rows, with what the record holds now.
  expect(r.log).toMatch(/REPORT: would correct paying-college-athletes\/u_d5eaf6d9 .*the record holds now: "The committee substitute tabled by Voice Vote\."/);
  expect(r.log).toMatch(/REPORT: left paying-college-athletes\/u_682cca41 /);
  expect(r.report.rows['paying-college-athletes/u_d5eaf6d9']).toMatchObject({ verdict: 'would-correct', record: [{ text: 'The committee substitute tabled by Voice Vote.' }], note: 'the record holds now' });
  expect(r.report.rows['paying-college-athletes/u_682cca41']).toMatchObject({ verdict: 'left' });
});

test('a night a guard would refuse: still byte-identical, still nothing applied, every row reported', () => {
  // The bill's latest action is on the list and is no other bill's (so it is
  // the bill's list), and every September line is gone: a guard would refuse.
  const UNIQUE = { actionDate: '2026-10-05', text: 'Stub latest action that only S. 4668 has.', sourceSystem: { name: 'House floor actions' } };
  const broken = [UNIQUE, ...WITH_LATEST].map((a, i) =>
    String(a.actionDate) >= '2026-09-15' && String(a.actionDate) <= '2026-09-24' ? { ...a, text: `Stub action ${i} with no relation to any stored line.`, recordedVotes: undefined } : a,
  );
  const r = night(broken, (dir) => {
    // The night's bill sync would have read the same latest action.
    const path = join(dir, 'data/bills.json');
    const bills = JSON.parse(readFileSync(path, 'utf8'));
    const b = bills.find((x: { full_identifier: string }) => x.full_identifier === 's-4668-119');
    b.last_action_date = UNIQUE.actionDate;
    b.last_action_text = UNIQUE.text;
    writeFileSync(path, JSON.stringify(bills));
  });
  expect(r.status, r.log.slice(-2000)).toBe(0);
  expect(r.same).toBe(true);
  expect(r.log).toContain('the source looks wrong for s-4668-119 tonight; its lines are unconfirmed, not reported as differences');
  expect(r.log).not.toContain('record re-check refused:');
  expect(r.log).not.toContain('recheck follow-up');
  // Report mode refuses PER BILL: S. 4668's lines are unconfirmed, none named as differing.
  expect(Object.keys(r.report.rows).filter((k) => r.report.rows[k].vehicle === 's-4668-119')).toEqual([]);
  expect(r.report.suspect['s-4668-119']).toMatchObject({ why: expect.stringContaining('would be corrected') });
  expect(Object.keys(r.report.suspect['s-4668-119'].rows).length).toBeGreaterThan(4); // the rows involved, unconfirmed
  expect(r.log).toContain('UNCONFIRMED (the source looked wrong)');
  expect(r.log).not.toMatch(/record re-check REPORT: would \w+ paying-college-athletes/);
});

test('a night with a HELD row already in the file (from an earlier apply era): report-only leaves it exactly as it is', () => {
  const r = night(RECORD_NOW, (dir) => {
    const path = join(dir, 'data/moment-updates.json');
    const file = JSON.parse(readFileSync(path, 'utf8'));
    const row = file['paying-college-athletes'].updates.find((u: { id: string }) => u.id === 'u_682cca41');
    const at = new Date().toISOString();
    row.withdrawn_on = etDay(at);
    row.rechecks = [{ on: etDay(at), at, outcome: 'held', was: 'Earlier words.', was_id: 'u_00000000', now: row.record.action_text }];
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  });
  expect(r.status, r.log.slice(-2000)).toBe(0);
  expect(r.same).toBe(true);
  expect(r.log).not.toContain('shows again');
  expect(r.log).not.toContain('recheck follow-up');
});

test('S1 · a hand-made stale model summary citing a held row: report mode writes no record-only revision, nothing at all', () => {
  const r = night(WITH_LATEST, (dir) => {
    const path = join(dir, 'data/moment-updates.json');
    const file = JSON.parse(readFileSync(path, 'utf8'));
    const entry = file['paying-college-athletes'];
    const row = entry.updates.find((u: { id: string }) => u.id === 'u_682cca41');
    const heldAt = new Date(Date.now() - 3_600_000).toISOString();
    row.withdrawn_on = etDay(heldAt);
    row.rechecks = [{ on: etDay(heldAt), at: heldAt, outcome: 'held', was: 'Earlier words.', was_id: 'u_00000000', now: row.record.action_text }];
    const last = entry.summary_revisions.at(-1);
    entry.summary_revisions.push({
      ...last,
      id: 's_0000abcd',
      generated_at: new Date(Date.now() - 7_200_000).toISOString(),
      as_of_day: etDay(new Date(Date.now() - 7_200_000)),
      model: 'claude-sonnet-5-5',
      grounded_in: { ...last.grounded_in, update_ids: ['u_682cca41'] },
    });
    entry.summary_revisions = entry.summary_revisions.slice(-30);
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  });
  expect(r.status, r.log.slice(-2000)).toBe(0);
  expect(r.same).toBe(true);
  expect(r.log).not.toContain('record-only: the re-check changed a cited line');
  expect(r.log).not.toContain('the record re-check changed');
});

test("item 3 · a would-withdraw line in the log keeps Oravan's words outside the record's quote", () => {
  // The Sept 17 cloture motion on the measure is replaced by an unrelated sentence: that stored line is on no row of the list.
  const changed = WITH_LATEST.map((a) => (String(a.text).startsWith('Cloture motion on the measure presented') ? { ...a, text: 'An unrelated action of that day, for this test.' } : a));
  const r = night(changed);
  expect(r.status, r.log.slice(-2000)).toBe(0);
  expect(r.same).toBe(true);
  expect(r.log).toMatch(/REPORT: would withdraw paying-college-athletes\/u_f0db9993 .* — stored: "Cloture motion on the measure presented in Senate\." — the record no longer holds it; that day it lists: "An unrelated action of that day, for this test\." \(2026-09-17\), /);
  expect(r.log).not.toMatch(/the record holds now: "(nothing like it|on no date)/);
});
