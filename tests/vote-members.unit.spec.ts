import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

import * as route from '../app/votes/[file]/route';
import { isClientModule, valueImportSpecifiers } from '../scripts/check-client-imports.mjs';
import { STRUCTURAL_MARKERS, checkChunks, corpusMarkers } from '../scripts/check-client-bundle.mjs';
import type { Legislator, RollCall, VotePosition, VotesFile } from '../lib/types';
import { voteMemberFileNames, voteMembersFor, voteMembersForFile } from '../lib/vote-members';
import { voteMembersFileName, voteMembersPath, type VoteMembersFile } from '../lib/vote-members-path';

/*
 * THE ROLL-CALL MEMBER FILES (2026-09-29). The bill page's vote record no
 * longer prints every member of every roll call; the build writes one static
 * JSON file per roll call (app/votes/[file]/route.ts, built by
 * lib/vote-members.ts) and components/VoteMembers.tsx fetches the one a reader
 * opens. These specs pin, without a build:
 *
 *   - one file per stored roll call, and every file says exactly what
 *     data/votes.json says: the same members, in the same four positions;
 *   - the route is static (force-static, no dynamic params) and 404s any name
 *     it did not write;
 *   - the client component reaches the URL helper only, never the vote file
 *     (the client-bundle rule), and the post-build gate knows the vote file's
 *     shape.
 *
 * Every expectation is recomputed from data/votes.json at test time.
 * tests/vote-record.spec.ts fetches the built files over HTTP;
 * tests/static-rendering.spec.ts pins them in the prerender manifest.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const VOTES = JSON.parse(read('data/votes.json')) as VotesFile;
const LEGISLATORS = new Map(
  (JSON.parse(read('data/legislators.json')) as Legislator[]).map((l) => [l.bioguide, l])
);
const ROSTER = new Map(VOTES.members.map((m) => [m.id, m]));
const POSITIONS: VotePosition[] = ['yea', 'nay', 'present', 'notVoting'];

/** Every way one built file can disagree with the record, as short strings. */
function disagreements(r: RollCall, file: VoteMembersFile): string[] {
  const out: string[] = [];
  if (file.id !== r.id) out.push(`${r.id}: id ${file.id}`);
  const want = POSITIONS.filter((p) => r.votes[p].length > 0);
  const got = file.groups.map((g) => g.position);
  if (got.join() !== want.join()) out.push(`${r.id}: groups ${got.join()} (record: ${want.join()})`);
  for (const g of file.groups) {
    const ids = g.members.map(([id]) => id);
    const record = r.votes[g.position];
    if (ids.length !== record.length) out.push(`${r.id} ${g.position}: ${ids.length} members, record ${record.length}`);
    if (new Set(ids).size !== ids.length) out.push(`${r.id} ${g.position}: a member listed twice`);
    const missing = record.filter((id) => !ids.includes(id));
    if (missing.length) out.push(`${r.id} ${g.position}: missing ${missing.join(',')}`);
    for (const [id, name, state] of g.members) {
      const l = LEGISLATORS.get(id);
      const m = ROSTER.get(id);
      const wantName = l?.name ?? m?.name ?? id;
      const wantState = l?.state ?? m?.state ?? '';
      if (name !== wantName || state !== wantState) out.push(`${r.id} ${id}: "${name} (${state})", want "${wantName} (${wantState})"`);
    }
    // Sorted by last name: checked over the sitting members, whose last name
    // data/legislators.json states outright.
    const lasts = g.members.map(([id]) => LEGISLATORS.get(id)?.last).filter((x): x is string => !!x);
    for (let i = 1; i < lasts.length; i++) {
      if (lasts[i - 1].localeCompare(lasts[i], 'en') > 0) {
        out.push(`${r.id} ${g.position}: ${lasts[i - 1]} before ${lasts[i]}`);
        break;
      }
    }
  }
  return out;
}

test.describe('one file per roll call, matching data/votes.json', () => {
  test('every stored roll call gets exactly one file, at a URL-safe name', () => {
    const names = voteMemberFileNames();
    expect(names.length).toBe(VOTES.rollCalls.length);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(VOTES.rollCalls.map((r) => voteMembersFileName(r.id)).sort());
    const unsafe = names.filter((n) => !/^[a-z0-9-]+\.json$/.test(n));
    expect(unsafe, 'a roll-call id that is not a plain path segment').toEqual([]);
    expect(voteMembersPath(VOTES.rollCalls[0].id)).toBe(`/votes/${VOTES.rollCalls[0].id}.json`);
  });

  test('every file lists exactly the record\'s members, in the record\'s positions and order', () => {
    // One collected assertion: 594 roll calls, ~130,000 member-votes.
    const misses = VOTES.rollCalls.flatMap((r) => disagreements(r, voteMembersFor(r)));
    expect(misses).toEqual([]);
  });

  test('a member who has left keeps the roster\'s name, and no party rides in a file', () => {
    const departed = VOTES.rollCalls.flatMap((r) =>
      POSITIONS.flatMap((p) => r.votes[p].filter((id) => !LEGISLATORS.has(id)).map((id) => ({ r, id })))
    )[0];
    test.skip(!departed, 'every member on record is still in data/legislators.json');
    const file = voteMembersFor(departed!.r);
    const row = file.groups.flatMap((g) => g.members).find(([id]) => id === departed!.id)!;
    expect(row[1]).toBe(ROSTER.get(departed!.id)?.name ?? departed!.id);
    const body = JSON.stringify(file);
    expect(body).not.toMatch(/Democrat|Republican|Independent|"party"/);
  });
});

test.describe('the route writes those files, statically', () => {
  test('force-static, no dynamic params: a name the build did not write is never rendered', () => {
    expect(route.dynamic).toBe('force-static');
    expect(route.dynamicParams).toBe(false);
    const params = route.generateStaticParams();
    expect(params.map((p) => p.file).sort()).toEqual(voteMemberFileNames().sort());
  });

  test('a known file answers the record as JSON; any other name is a 404', async () => {
    const r = VOTES.rollCalls[0];
    const ok = await route.GET(new Request('http://x/'), { params: Promise.resolve({ file: `${r.id}.json` }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/^application\/json/);
    expect(ok.headers.get('set-cookie')).toBeNull();
    const body = (await ok.json()) as VoteMembersFile;
    expect(disagreements(r, body)).toEqual([]);

    for (const file of ['h-0-0-0.json', r.id, `${r.id}.xml`, `../${r.id}.json`]) {
      expect(voteMembersForFile(file), file).toBeNull();
      const res = await route.GET(new Request('http://x/'), { params: Promise.resolve({ file }) });
      expect(res.status, file).toBe(404);
    }
  });
});

test.describe('the browser gets the URL, never the vote file', () => {
  const CLIENT = 'components/VoteMembers.tsx';

  test('the disclosure is a client module whose only data-side import is the import-free path helper', () => {
    const src = read(CLIENT);
    expect(isClientModule(CLIENT, src)).toBe(true);
    const specs = valueImportSpecifiers(CLIENT, src);
    expect(specs).toContain('@/lib/vote-members-path');
    for (const banned of ['@/lib/votes', '@/lib/vote-members', '@/lib/core']) expect(specs).not.toContain(banned);
    expect(specs.filter((s: string) => s.includes('data/'))).toEqual([]);
    // The helper itself imports nothing by value.
    expect(valueImportSpecifiers('lib/vote-members-path.ts', read('lib/vote-members-path.ts'))).toEqual([]);
  });

  test('it fetches same-origin, without credentials', () => {
    const src = read(CLIENT);
    expect(src).toMatch(/fetch\(voteMembersPath\(rollCallId\), \{ credentials: 'omit' \}\)/);
    expect(src).not.toMatch(/https?:\/\//);
  });

  test('the pre-build import gate is clean with the disclosure in the tree', () => {
    const run = spawnSync('node', ['scripts/check-client-imports.mjs'], { cwd: process.cwd(), encoding: 'utf8' });
    expect(run.status, run.stderr || run.stdout).toBe(0);
  });

  test('the post-build chunk gate knows the vote file by shape, and catches one roll call inlined', () => {
    expect(STRUCTURAL_MARKERS.filter((m) => m.source.startsWith('data/votes.json')).length).toBeGreaterThan(0);
    const { markers } = corpusMarkers();
    // The first roll call with no question long enough to yield a prose
    // marker: only the shape markers can catch it.
    const r = VOTES.rollCalls.find((x) => x.question.length < 100) ?? VOTES.rollCalls[0];
    const inline = `x.exports=JSON.parse('${JSON.stringify(r)}')`;
    const found = checkChunks([{ file: 'leak.js', text: inline, bytes: Buffer.byteLength(inline) }], markers);
    expect(found.map((f) => f.rule)).toContain('corpus');
    // And the component that fetches it is clean against the same markers.
    const client = read(CLIENT);
    expect(checkChunks([{ file: CLIENT, text: client, bytes: Buffer.byteLength(client) }], markers)).toEqual([]);
  });
});
