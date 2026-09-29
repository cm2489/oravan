import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backfillBlockers, walkHouseClerk } from '../lib/votes-backfill.mjs';
import {
  LOOKBACK_DAYS,
  VoteParseError,
  clerkIndexUrl,
  clerkRollUrl,
  houseClerkMeta,
  parseClerkIndexMax,
  parseHouseClerkXml,
  parseSenateXml,
  resolveFloor,
  verifyVotes,
} from '../lib/votes-core.mjs';
import type { VotesFile } from '../lib/types';

/*
 * THE BACK-FILL (owner, 2026-09-29: "Can we get the votes from this entire
 * current congress? That is public record so let's back fill them all for
 * every bill."). `scripts/sync-votes.mjs --backfill-from` moves the file's
 * floor back and lists the House from the Clerk's own record, with no API
 * key. Everything here runs on fixtures, with no network:
 *
 *   clerk-index-2026-rolls-70-72.html  clerk.house.gov evs/2026 index page,
 *                                      the real frame with rows 70-72 only
 *   clerk-index-2025-rolls-1-2.html    the same for 2025, rows 1-2
 *   clerk-2026-roll072-s2503.xml       S. 2503 (ROTOR Act), motion to suspend
 *                                      the rules and pass, failed, 2026-02-24
 *   clerk-2026-roll071-hr6329.xml      H.R. 6329, the same day
 *   clerk-2026-roll070-hr2189.xml      H.R. 2189, 2026-02-12
 *   clerk-2025-roll001-quorum.xml      the 119th's first roll call, a quorum
 *                                      call ("Present")
 *   clerk-2025-roll002-speaker.xml     the Speaker election: every cast is a
 *                                      name, which parseHouseClerkXml refuses
 *   clerk-2025-roll244-amendment-      a House amendment vote on H.R. 3838
 *     hr3838.xml                       (the back-fill skips these, as the
 *                                      nightly does)
 *   senate-vote-menu-119-1.xml         senate.gov, 2025: the menu's first vote
 *                                      (cloture on the motion to proceed to S. 5)
 *   senate-vote-119-1-00001.xml        that vote, with Marco Rubio (S350), who
 *                                      left the Senate 2025-01-20
 *   backfill-upstream-*.json           the two upstream roster records the
 *                                      script falls back on (congress-legislators)
 *
 * All real records fetched 2026-09-29, redacted to a few members each, with
 * the totals rewritten to match the members kept (the convention of
 * tests/votes.unit.spec.ts), except the Speaker election, which is never
 * parsed past its metadata.
 */

const FX = join(process.cwd(), 'tests/fixtures/votes');
const fx = (name: string) => readFileSync(join(FX, name), 'utf8');

const ROLL72 = clerkRollUrl(2026, 72);
const ROLL71 = clerkRollUrl(2026, 71);
const ROLL70 = clerkRollUrl(2026, 70);

/** A fetcher over fixtures that records every URL asked for. Unknown → 404. */
function fixtureFetcher(map: Record<string, string>) {
  const asked: string[] = [];
  const get = async (url: string) => {
    asked.push(url);
    if (!(url in map)) throw new Error(`404 for ${url}`);
    return fx(map[url]);
  };
  return { asked, get };
}

const heldBelow = (session: number, n: number) => new Set(Array.from({ length: n }, (_, i) => `h-119-${session}-${i + 1}`));

test.describe('the Clerk listing', () => {
  test('URLs are the ones the Clerk publishes', () => {
    expect(clerkRollUrl(2026, 72)).toBe('https://clerk.house.gov/evs/2026/roll072.xml');
    expect(clerkRollUrl(2025, 5)).toBe('https://clerk.house.gov/evs/2025/roll005.xml');
    expect(clerkRollUrl(2026, 314)).toBe('https://clerk.house.gov/evs/2026/roll314.xml');
    expect(clerkIndexUrl(2025)).toBe('https://clerk.house.gov/evs/2025/index.asp');
  });

  test('the index page gives the year\'s highest roll number, and refuses to guess', () => {
    expect(parseClerkIndexMax(fx('clerk-index-2026-rolls-70-72.html'), 2026)).toBe(72);
    expect(parseClerkIndexMax(fx('clerk-index-2025-rolls-1-2.html'), 2025)).toBe(2);
    expect(() => parseClerkIndexMax(fx('clerk-index-2026-rolls-70-72.html'), 2025)).toThrow(VoteParseError);
    expect(() => parseClerkIndexMax('<html>Service Unavailable</html>', 2026)).toThrow(/lists no roll call/);
  });

  test('metadata alone names the date and the bill, exactly as the full parse does', () => {
    const corpus = new Set(['s-2503-119']);
    const meta = houseClerkMeta(fx('clerk-2026-roll072-s2503.xml'), { corpus });
    expect(meta).toMatchObject({ congress: 119, session: 2, roll: 72, date: '2026-02-24', bill: 's-2503-119' });
    expect(meta.question).toBe('On Motion to Suspend the Rules and Pass');
    expect(meta.result).toBe('Failed');
    expect(houseClerkMeta(fx('clerk-2026-roll072-s2503.xml'), { corpus: new Set() }).bill).toBeNull();
    expect(parseHouseClerkXml(fx('clerk-2026-roll072-s2503.xml'), { corpus }).roll.bill).toBe(meta.bill);
  });

  test('the Speaker election reads as metadata (no bill) though its casts cannot be parsed', () => {
    const xml = fx('clerk-2025-roll002-speaker.xml');
    expect(houseClerkMeta(xml, { corpus: new Set(['hr-1-119']) })).toMatchObject({ roll: 2, date: '2025-01-03', bill: null });
    expect(() => parseHouseClerkXml(xml, { corpus: new Set() })).toThrow(VoteParseError);
  });
});

test.describe('walkHouseClerk', () => {
  const corpus = new Set(['s-2503-119', 'hr-2189-119']);
  const base = { congress: 119, session: 2 as const, floor: '2025-01-03', corpus };
  const pages = {
    [clerkIndexUrl(2026)]: 'clerk-index-2026-rolls-70-72.html',
    [ROLL72]: 'clerk-2026-roll072-s2503.xml',
    [ROLL71]: 'clerk-2026-roll071-hr6329.xml',
    [ROLL70]: 'clerk-2026-roll070-hr2189.xml',
  };

  test('stores the corpus roll calls through the Clerk parser, skips the rest, and never refetches a held one', async () => {
    const f = fixtureFetcher(pages);
    const walk = await walkHouseClerk({ ...base, held: heldBelow(2, 69), getText: f.get });
    // Rolls 1-69 are held: not one of them is fetched.
    expect(f.asked).toEqual([clerkIndexUrl(2026), ROLL70, ROLL71, ROLL72]);
    expect(walk.maxRoll).toBe(72);
    expect(walk.parsed.map((p) => [p.roll.id, p.roll.bill])).toEqual([
      ['h-119-2-70', 'hr-2189-119'],
      ['h-119-2-72', 's-2503-119'],
    ]);
    const r72 = walk.parsed[1].roll;
    expect(r72.date).toBe('2026-02-24');
    expect(r72.source).toBe(ROLL72);
    expect(r72.question).toBe('On Motion to Suspend the Rules and Pass');
    expect(r72.result).toBe('Failed');
    // Totals and positions agree (the gate's own check, on the parse).
    for (const k of ['yea', 'nay', 'present', 'notVoting'] as const) expect(r72.totals[k]).toBe(r72.votes[k].length);
    expect(walk.examined.map((e) => e.roll)).toEqual(Array.from({ length: 72 }, (_, i) => i + 1));
    expect(walk.examined.some((e) => e.failed)).toBe(false);
    expect(walk.stats).toEqual({ listed: 72, inWindow: 72, corpus: 71, stored: 2, failed: 0 });
  });

  test('a missing record is a reported failure, not a silent gap', async () => {
    const f = fixtureFetcher({ ...pages, [ROLL71]: '__missing__' });
    const logs: string[] = [];
    const walk = await walkHouseClerk({
      ...base,
      held: heldBelow(2, 69),
      getText: async (url) => (url === ROLL71 ? Promise.reject(new Error(`404 for ${url}`)) : f.get(url)),
      log: (l) => logs.push(l),
    });
    expect(walk.examined.find((e) => e.roll === 71)).toEqual({ roll: 71, date: null, failed: true });
    expect(walk.stats.failed).toBe(1);
    expect(walk.parsed.map((p) => p.roll.id)).toEqual(['h-119-2-70', 'h-119-2-72']);
    expect(logs.some((l) => l.startsWith('::error::') && l.includes('h-119-2-71'))).toBe(true);
  });

  test('a record for a different roll than its URL is refused', async () => {
    const f = fixtureFetcher({ ...pages, [ROLL71]: 'clerk-2026-roll072-s2503.xml' });
    const walk = await walkHouseClerk({ ...base, held: heldBelow(2, 69), getText: f.get });
    expect(walk.examined.find((e) => e.roll === 71)).toEqual({ roll: 71, date: null, failed: true });
  });

  test('roll calls before the floor are examined but not stored', async () => {
    const f = fixtureFetcher(pages);
    const walk = await walkHouseClerk({ ...base, floor: '2026-02-20', held: heldBelow(2, 69), getText: f.get });
    expect(walk.parsed.map((p) => p.roll.id)).toEqual(['h-119-2-72']);
    expect(walk.stats.inWindow).toBe(69 + 2);
  });

  test('a House AMENDMENT vote is skipped, as the nightly skips it, though the Clerk names the bill', async () => {
    // Roll 244 of 2025: an amendment to H.R. 3838. The Clerk's <legis-num>
    // says "H R 3838"; Congress.gov's list leaves the vote's legislation
    // fields empty, so the nightly has never attached a House amendment vote.
    const xml = fx('clerk-2025-roll244-amendment-hr3838.xml');
    const corpus3838 = new Set(['hr-3838-119']);
    expect(houseClerkMeta(xml, { corpus: corpus3838 })).toMatchObject({ roll: 244, bill: 'hr-3838-119', amendment: '23', date: '2025-09-10' });
    expect(houseClerkMeta(fx('clerk-2026-roll072-s2503.xml'), { corpus }).amendment).toBeNull();
    const index = '<a href="http://clerk.house.gov/cgi-bin/vote.asp?year=2025&rollnumber=244">244</a>';
    const walk = await walkHouseClerk({
      congress: 119,
      session: 1,
      floor: '2025-01-03',
      corpus: corpus3838,
      held: heldBelow(1, 243),
      getText: async (url) => (url === clerkIndexUrl(2025) ? index : xml),
    });
    expect(walk.parsed).toEqual([]);
    expect(walk.examined.at(-1)).toEqual({ roll: 244, date: '2025-09-10' });
    expect(walk.stats).toMatchObject({ stored: 0, failed: 0, corpus: 243 });
  });

  test('getRoll carries the roll documents and getText only the index page', async () => {
    const index = fixtureFetcher(pages);
    const rolls = fixtureFetcher(pages);
    await walkHouseClerk({ ...base, held: heldBelow(2, 69), getText: index.get, getRoll: rolls.get });
    expect(index.asked).toEqual([clerkIndexUrl(2026)]);
    expect(rolls.asked).toEqual([ROLL70, ROLL71, ROLL72]);
  });
});

test.describe('backfillBlockers: the failures a back-fill answers for', () => {
  test('a failure before the old floor blocks; one after it is the nightly\'s to retry', () => {
    const examined = [
      { roll: 1, date: '2025-01-03' },
      { roll: 2, date: null, failed: true }, // undated, and nothing below it reaches the old floor
      { roll: 3, date: '2026-06-01' },
      { roll: 4, date: null, failed: true }, // undated, but roll 3 is already past the old floor
      { roll: 5, date: '2026-09-28', failed: true }, // a same-day Senate vote not published yet
      { roll: 6, date: '2026-05-01', failed: true }, // dated, and before the old floor (out of order on purpose)
    ];
    expect(backfillBlockers(examined, '2026-05-27')).toEqual([2, 6]);
  });

  test('with no old floor, every failure blocks', () => {
    expect(backfillBlockers([{ roll: 250, date: '2026-09-28', failed: true }, { roll: 1, date: '2025-01-03' }], null)).toEqual([250]);
  });

  test('no failures, no blockers', () => {
    expect(backfillBlockers([{ roll: 1, date: '2025-01-03' }], '2026-05-27')).toEqual([]);
  });
});

test.describe('the floor', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');

  test('a nightly or intraday run never moves it', () => {
    expect(resolveFloor({ existingFloor: '2025-01-03', congress: 119, now })).toBe('2025-01-03');
    expect(resolveFloor({ existingFloor: '2026-05-27', congress: 119, now })).toBe('2026-05-27');
  });

  test('the first run reaches back LOOKBACK_DAYS', () => {
    expect(resolveFloor({ congress: 119, now })).toBe(new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10));
  });

  test('a back-fill moves it back, and only back', () => {
    expect(resolveFloor({ existingFloor: '2026-05-27', backfillFrom: '2025-01-03', congress: 119, now })).toBe('2025-01-03');
    expect(resolveFloor({ existingFloor: '2025-01-03', backfillFrom: '2025-01-03', congress: 119, now })).toBe('2025-01-03');
    expect(() => resolveFloor({ existingFloor: '2025-01-03', backfillFrom: '2026-05-27', congress: 119, now })).toThrow(/only moves the floor back/);
  });

  test('a back-fill date outside the Congress, in the future, or malformed is refused', () => {
    expect(() => resolveFloor({ backfillFrom: '2024-12-31', congress: 119, now })).toThrow(/outside the 119th Congress/);
    expect(() => resolveFloor({ backfillFrom: '2026-10-01', congress: 119, now })).toThrow(/in the future/);
    expect(() => resolveFloor({ backfillFrom: '2025-02-30', congress: 119, now })).toThrow(/not a YYYY-MM-DD/);
    expect(() => resolveFloor({ backfillFrom: '', congress: 119, now })).toThrow(/not a YYYY-MM-DD/);
  });
});

/*
 * THE SCRIPT ITSELF, end to end, with fetch replaced by a fixture server
 * (tests/fixtures/votes-backfill-fetch-mock.mjs, loaded with `node --import`):
 * nothing can reach the network, and no key is set.
 */
test.describe('scripts/sync-votes.mjs --backfill-from', () => {
  const SCRIPT = join(process.cwd(), 'scripts/sync-votes.mjs');
  const MOCK = pathToFileURL(join(process.cwd(), 'tests/fixtures/votes-backfill-fetch-mock.mjs')).href;

  // The senators the fixtures name, with their real LIS ids and bioguide ids
  // (unitedstates/congress-legislators, read 2026-09-29), and one Florida
  // senator so the departed Florida senator's seat exists. S350 (the
  // departed senator in vote 1 of 2025) is deliberately NOT here: the run
  // must resolve it through the upstream roster, as the nightly does.
  const SENATORS = [
    { bioguide: 'A000383', lis: 'S440', state: 'OK' },
    { bioguide: 'A000382', lis: 'S428', state: 'MD' },
    { bioguide: 'C001088', lis: 'S337', state: 'DE' },
    { bioguide: 'B001288', lis: 'S370', state: 'NJ' },
    { bioguide: 'H001076', lis: 'S388', state: 'NH' },
    { bioguide: 'S001217', lis: 'S404', state: 'FL' },
  ].map((s) => ({ ...s, name: `Senator ${s.bioguide}`, type: 'sen' }));
  const lisToBioguide = (id: string) => SENATORS.find((s) => s.lis === id)?.bioguide ?? null;
  /** Roll 72's kept Nay, left out of data/legislators.json here; its full
   *  name is in the upstream fixture, and the Clerk's record says "Aderholt". */
  const HOUSE_DEPARTED = 'A000055';

  /** A temp repo: a tiny corpus, the members the fixtures name, and the
   *  committed shape of data/votes.json before the back-fill. */
  function setup(extraCorpus: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'votes-backfill-'));
    mkdirSync(join(dir, 'data'));
    const corpus = ['s-2503-119', 'hr-2189-119', 'hr-3633-119', 's-5-119', ...extraCorpus];
    writeFileSync(join(dir, 'data/bills.json'), JSON.stringify(corpus.map((id) => ({ full_identifier: id }))));
    const house = new Map<string, string>();
    for (const f of ['clerk-2026-roll072-s2503.xml', 'clerk-2026-roll070-hr2189.xml']) {
      for (const m of fx(f).matchAll(/name-id="([^"]+)"[^>]*state="([A-Z]{2})"/g)) house.set(m[1], m[2]);
    }
    const departedState = house.get(HOUSE_DEPARTED)!;
    house.delete(HOUSE_DEPARTED);
    const legislators = [
      ...[...house].map(([bioguide, state]) => ({ bioguide, name: `Member ${bioguide}`, type: 'rep', state })),
      // Whoever holds the departed member's seat now.
      { bioguide: 'Z000001', name: 'Seat Holder', type: 'rep', state: departedState },
      ...SENATORS,
    ];
    writeFileSync(join(dir, 'data/legislators.json'), JSON.stringify(legislators));
    writeFileSync(join(dir, 'data/vacancies.json'), '[]');
    const held = parseSenateXml(fx('senate-vote-119-2-00234.xml'), {
      corpus: new Set(corpus),
      sourceUrl: 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00234.xml',
      lisToBioguide,
    });
    const before = {
      _meta: {
        schema: 1,
        floor: '2026-05-27',
        updatedAt: '2026-09-28T04:00:00Z',
        cursor: { house: '119-2-314', senate: '119-2-248' },
        sources: { house: 'x', senate: 'y' },
      },
      rollCalls: [held.roll],
      members: held.members
        .map((m) => ({ id: m.id, name: m.name, state: m.state, chamber: 'senate' }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
    writeFileSync(join(dir, 'data/votes.json'), JSON.stringify(before));
    return { dir, corpus: new Set(corpus), legislators };
  }

  function run(dir: string, args: string[], env: Record<string, string> = {}) {
    const log = join(dir, 'fetched.log');
    rmSync(log, { force: true });
    const clean: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(clean)) if (/^(CONGRESS_API_KEY|ANTHROPIC_API_KEY|NEWS_API_KEY|UPSTASH_)/.test(k)) delete clean[k];
    const r = spawnSync(process.execPath, ['--import', MOCK, SCRIPT, ...args], {
      cwd: dir,
      env: { ...clean, VOTES_THROTTLE_MS: '0', MOCK_FIXTURES: FX, MOCK_LOG: log, ...env } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const fetched = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return { status: r.status, signal: r.signal, out: `${r.stdout}\n${r.stderr}`, fetched };
  }

  const readVotes = (dir: string) => readFileSync(join(dir, 'data/votes.json'), 'utf8');
  const strayTemps = (dir: string) => readdirSync(join(dir, 'data')).filter((f) => f.includes('.tmp'));

  test('writes a gate-passing file: floor moved back, cursors kept, departed members named', () => {
    const { dir, corpus, legislators } = setup();
    try {
      const r = run(dir, ['--backfill-from', '2025-01-03', '--cache-dir', join(dir, 'cache')]);
      expect(r.status, r.out).toBe(0);
      const raw = readVotes(dir);
      const data = JSON.parse(raw) as VotesFile;
      expect(data._meta.floor).toBe('2025-01-03');
      // The Clerk's 2026 index tops out at 72 here, below the file's cursor:
      // a back-fill never moves a cursor backward.
      expect(data._meta.cursor).toEqual({ house: '119-2-314', senate: '119-2-248' });
      expect(data.rollCalls.map((x) => x.id)).toEqual(['h-119-2-70', 'h-119-2-72', 's-119-1-1', 's-119-2-234']);
      expect(data.rollCalls.find((x) => x.id === 's-119-1-1')!.bill).toBe('s-5-119');
      // A departed senator: LIS id resolved through the upstream roster, the
      // name as the Senate's record prints it.
      expect(data.members.find((m) => m.id === 'R000595')).toEqual({ id: 'R000595', name: 'Marco Rubio', state: 'FL', chamber: 'senate' });
      // A departed House member: the Clerk prints only "Aderholt"; the full
      // name comes from the upstream roster.
      expect(data.members.find((m) => m.id === HOUSE_DEPARTED)).toEqual({ id: HOUSE_DEPARTED, name: 'Robert B. Aderholt', state: 'AL', chamber: 'house' });
      // A current member keeps data/legislators.json's name.
      expect(data.members.find((m) => m.id === 'A000370')?.name).toBe('Member A000370');
      const v = verifyVotes({ data, fileBytes: Buffer.byteLength(raw), corpus, legislators, vacancies: [] });
      expect(v.failures).toEqual([]);
      // Never a Congress.gov request: the House came from the Clerk.
      expect(r.fetched.some((u) => u.includes('api.congress.gov'))).toBe(false);
      expect(r.fetched).toContain('https://clerk.house.gov/evs/2025/index.asp');
      expect(strayTemps(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('one failed roll call writes NOTHING: the old file stays byte for byte', () => {
    const { dir } = setup();
    try {
      const before = readVotes(dir);
      const r = run(dir, ['--backfill-from', '2025-01-03'], { MOCK_404: 'roll072.xml' });
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/back-fill incomplete/);
      expect(readVotes(dir)).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failure on or after the old floor does not hold the back-fill back', () => {
    // S. 4668's Senate votes 235 and 236 (September 2026, after the old floor
    // of 2026-05-27) are on the session-2 menu fixture, and no record for
    // them is served: the same shape as a same-day vote senate.gov has not
    // published yet.
    const { dir } = setup(['s-4668-119']);
    try {
      const r = run(dir, ['--backfill-from', '2025-01-03']);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/s-119-2-235 \(s-4668-119\) not stored/);
      expect(r.out).toMatch(/do not hold back the back-fill/);
      const data = JSON.parse(readVotes(dir)) as VotesFile;
      expect(data._meta.floor).toBe('2025-01-03');
      expect(data.rollCalls.map((x) => x.id)).toEqual(['h-119-2-70', 'h-119-2-72', 's-119-1-1', 's-119-2-234']);
      expect(data._meta.cursor.senate).toBe('119-2-248');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a crash mid-run leaves the old file whole, and the re-run resumes from the cache', () => {
    const { dir } = setup();
    try {
      const before = readVotes(dir);
      const cache = join(dir, 'cache');
      const crashed = run(dir, ['--backfill-from', '2025-01-03', '--cache-dir', cache], { MOCK_CRASH_AT: 'roll071.xml' });
      expect(crashed.signal).toBe('SIGKILL');
      expect(readVotes(dir)).toBe(before);
      expect(strayTemps(dir)).toEqual([]);
      const isRecord = (u: string) => /roll\d+\.xml$|\/vote_119_\d_\d+\.xml$/.test(u);
      const firstPass = crashed.fetched.filter((u) => isRecord(u) && !u.endsWith('roll071.xml'));
      expect(firstPass.length).toBeGreaterThan(60);

      const resumed = run(dir, ['--backfill-from', '2025-01-03', '--cache-dir', cache]);
      expect(resumed.status, resumed.out).toBe(0);
      // Every record the crashed run finished is read from the cache.
      expect(resumed.fetched.filter((u) => firstPass.includes(u))).toEqual([]);
      expect(resumed.fetched.filter(isRecord)).toEqual(['https://clerk.house.gov/evs/2026/roll071.xml', 'https://clerk.house.gov/evs/2026/roll072.xml']);
      expect((JSON.parse(readVotes(dir)) as VotesFile)._meta.floor).toBe('2025-01-03');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('afterwards the nightly lists every session in the window, the intraday run only the newest, and neither moves the floor', () => {
    const { dir } = setup();
    try {
      expect(run(dir, ['--backfill-from', '2025-01-03']).status).toBe(0);
      const after = readVotes(dir);
      // No key here, so both House lists fail (exit 1) — what differs is
      // which sessions each run looks at.
      const nightly = run(dir, []);
      expect(nightly.out).toMatch(/session\(s\) 1, 2, floor 2025-01-03,/);
      expect(nightly.fetched).toContain('https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_1.xml');
      const intraday = run(dir, ['--only-new-rolls']);
      expect(intraday.out).toMatch(/session\(s\) 2, floor 2025-01-03,/);
      expect(intraday.fetched.some((u) => u.includes('vote_menu_119_1'))).toBe(false);
      // Nothing new was stored, so the file (floor included) is unchanged.
      expect(readVotes(dir)).toBe(after);
      expect((JSON.parse(after) as VotesFile)._meta.floor).toBe('2025-01-03');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a back-fill that would move the floor forward is refused before any request', () => {
    const { dir } = setup();
    try {
      const before = readVotes(dir);
      const r = run(dir, ['--backfill-from', '2026-06-01']);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/only moves the floor back/);
      expect(r.fetched).toEqual([]);
      expect(readVotes(dir)).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('the committed file', () => {
  test('holds no House amendment vote: one rule for the whole window, the nightly\'s', () => {
    const data = JSON.parse(readFileSync(join(process.cwd(), 'data/votes.json'), 'utf8')) as VotesFile;
    const house = data.rollCalls.filter((r) => r.chamber === 'house');
    expect(house.length).toBeGreaterThan(0);
    expect(house.filter((r) => /^On Agreeing to the Amendment/.test(r.question ?? '')).map((r) => r.id)).toEqual([]);
  });
});
