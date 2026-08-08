import { expect, test } from '@playwright/test';
// Pure, I/O-free module (no git, no network) — see scripts/merge-sync-state.mjs's
// header for the incident it exists to prevent and the per-key reasoning.
import { isTimestamp, mergeSyncState } from '../scripts/merge-sync-state.mjs';

/*
 * These tests PIN the union semantics for data/sync-state.json. If one of them
 * surprises you, the resolution rule changed — and a wrong rule here does not
 * fail loudly, it silently moves a Congress.gov cursor. Retune deliberately and
 * update the WHY block in merge-sync-state.mjs alongside the pin.
 *
 * Vocabulary, matching the module: `remote` is git stage 2 (origin/main, the
 * branch being rebased ONTO) and `run` is stage 3 (the sync commit being
 * replayed). That is git's rebase inversion, and getting it backwards is the
 * single easiest way to break this file.
 */

const merged = (args: { base?: unknown; remote: unknown; run: unknown }) =>
  mergeSyncState(args).merged;

test.describe('the incident: PR #166 adds a key mid-sync (run 31194836148)', () => {
  // The exact shape that cost ~2,373 paid TheNewsAPI requests on 2026-08-07.
  const base = {
    lastSync: '2026-08-06T07:31:02Z',
    lastRun: '2026-08-06T07:31:02.144Z',
    note: 'Cursor-format outage #2: …',
  };
  const remote = { ...base, nominationsLastSync: '2026-08-06T17:51:06Z' }; // main, post-#166
  const run = {
    lastSync: '2026-08-07T15:53:11Z',
    lastRun: '2026-08-07T15:53:11.902Z',
    note: 'Cursor-format outage #2: …',
  };

  test('resolves to the union — the run keeps its cursors, main keeps its new key', () => {
    expect(merged({ base, remote, run })).toEqual({
      lastSync: '2026-08-07T15:53:11Z',
      lastRun: '2026-08-07T15:53:11.902Z',
      note: 'Cursor-format outage #2: …',
      nominationsLastSync: '2026-08-06T17:51:06Z',
    });
  });

  test('key order matches what an unraced sync commit would have written', () => {
    expect(Object.keys(merged({ base, remote, run }))).toEqual([
      'lastSync',
      'lastRun',
      'note',
      'nominationsLastSync',
    ]);
  });
});

test.describe('disjoint keys', () => {
  test('each side keeps the key only it added', () => {
    expect(
      merged({ base: {}, remote: { fromMain: 'a' }, run: { fromRun: 'b' } })
    ).toEqual({ fromRun: 'b', fromMain: 'a' });
  });

  test('a key only ONE side has ever heard of survives (the #166 shape, generalized)', () => {
    const base = { shared: '2026-01-01T00:00:00Z' };
    expect(
      merged({ base, remote: { ...base, brandNew: 'x' }, run: { ...base } })
    ).toEqual({ shared: '2026-01-01T00:00:00Z', brandNew: 'x' });
  });
});

test.describe('same key, both sides moved it: the NEWER timestamp wins', () => {
  const base = { lastSync: '2026-08-01T00:00:00Z' };

  test('run is newer -> run wins', () => {
    const out = merged({
      base,
      remote: { lastSync: '2026-08-05T00:00:00Z' },
      run: { lastSync: '2026-08-07T00:00:00Z' },
    });
    expect(out.lastSync).toBe('2026-08-07T00:00:00Z');
  });

  test('remote is newer -> remote wins (the same call, arguments swapped)', () => {
    const out = merged({
      base,
      remote: { lastSync: '2026-08-07T00:00:00Z' },
      run: { lastSync: '2026-08-05T00:00:00Z' },
    });
    expect(out.lastSync).toBe('2026-08-07T00:00:00Z');
  });

  test('the result is identical whichever side the newer value is on (order-independent)', () => {
    const a = merged({ base, remote: { lastSync: '2026-08-05T00:00:00Z' }, run: { lastSync: '2026-08-07T00:00:00Z' } });
    const b = merged({ base, remote: { lastSync: '2026-08-07T00:00:00Z' }, run: { lastSync: '2026-08-05T00:00:00Z' } });
    expect(a).toEqual(b);
  });

  test('millisecond precision is compared by instant, not by string length', () => {
    const out = merged({
      base: { lastRun: '2026-08-01T00:00:00.000Z' },
      remote: { lastRun: '2026-08-07T00:00:00.500Z' },
      run: { lastRun: '2026-08-07T00:00:00.100Z' },
    });
    expect(out.lastRun).toBe('2026-08-07T00:00:00.500Z');
  });

  test('the winner is copied VERBATIM — never re-serialized through a Date', () => {
    // Re-emitting a seconds-precision cursor via toISOString() would append
    // `.000Z`, which is precisely what Congress.gov 400s (outage #2). The
    // seconds-precision string must survive byte for byte.
    const out = merged({
      base: { lastSync: '2026-08-01T00:00:00Z' },
      remote: { lastSync: '2026-08-05T09:08:07Z' },
      run: { lastSync: '2026-08-07T01:02:03Z' },
    });
    expect(out.lastSync).toBe('2026-08-07T01:02:03Z');
    expect(String(out.lastSync)).not.toContain('.');
  });
});

test.describe('no cursor ever moves backwards', () => {
  const cursorKeys = ['lastSync', 'lastRun', 'nominationsLastSync'];

  // Every ordering of two plausible cursor values, on both sides, against
  // three different bases (older, equal-to-one, absent).
  const stamps = ['2026-08-05T00:00:00Z', '2026-08-06T00:00:00Z', '2026-08-07T00:00:00Z'];
  const bases: Array<Record<string, string>> = [
    { seed: '2026-08-01T00:00:00Z' },
    {},
  ];

  for (const key of cursorKeys) {
    for (const remoteValue of stamps) {
      for (const runValue of stamps) {
        for (const [i, seed] of bases.entries()) {
          test(`${key}: remote=${remoteValue.slice(8, 10)} run=${runValue.slice(8, 10)} base#${i} never regresses`, () => {
            const base = { ...seed, [key]: '2026-08-01T00:00:00Z' };
            const out = merged({
              base,
              remote: { ...base, [key]: remoteValue },
              run: { ...base, [key]: runValue },
            });
            const won = Date.parse(String(out[key]));
            expect(won).toBeGreaterThanOrEqual(Date.parse(remoteValue));
            expect(won).toBeGreaterThanOrEqual(Date.parse(runValue));
            expect(won).toBe(Math.max(Date.parse(remoteValue), Date.parse(runValue)));
          });
        }
      }
    }
  }
});

test.describe('no key is ever lost', () => {
  const scenarios: Array<{
    name: string;
    base: Record<string, unknown>;
    remote: Record<string, unknown>;
    run: Record<string, unknown>;
  }> = [
    {
      name: 'the #166 shape',
      base: { lastSync: '2026-08-06T00:00:00Z', note: 'n' },
      remote: { lastSync: '2026-08-06T00:00:00Z', note: 'n', nominationsLastSync: '2026-08-06T17:51:06Z' },
      run: { lastSync: '2026-08-07T00:00:00Z', note: 'n' },
    },
    {
      name: 'both sides add a different new key',
      base: { lastSync: '2026-08-06T00:00:00Z' },
      remote: { lastSync: '2026-08-06T00:00:00Z', a: '1' },
      run: { lastSync: '2026-08-07T00:00:00Z', b: '2' },
    },
    {
      name: 'both sides move the same cursor',
      base: { lastSync: '2026-08-01T00:00:00Z', note: 'n' },
      remote: { lastSync: '2026-08-06T00:00:00Z', note: 'n' },
      run: { lastSync: '2026-08-07T00:00:00Z', note: 'n' },
    },
    {
      name: 'no merge base at all (2-way degradation)',
      base: {},
      remote: { lastSync: '2026-08-06T00:00:00Z', onlyMain: 'x' },
      run: { lastSync: '2026-08-07T00:00:00Z', onlyRun: 'y' },
    },
  ];

  for (const s of scenarios) {
    test(`${s.name}: every key present on either live side survives`, () => {
      const out = merged({ base: s.base, remote: s.remote, run: s.run });
      for (const key of [...Object.keys(s.remote), ...Object.keys(s.run)]) {
        expect(out, `key "${key}" was dropped`).toHaveProperty(key);
      }
    });
  }
});

test.describe('an empty side', () => {
  test('empty remote: the run keeps everything it wrote', () => {
    expect(merged({ base: {}, remote: {}, run: { lastSync: '2026-08-07T00:00:00Z' } })).toEqual({
      lastSync: '2026-08-07T00:00:00Z',
    });
  });

  test('empty run: main keeps everything it holds', () => {
    expect(merged({ base: {}, remote: { lastSync: '2026-08-07T00:00:00Z' }, run: {} })).toEqual({
      lastSync: '2026-08-07T00:00:00Z',
    });
  });

  test('both sides empty resolves to an empty object rather than throwing', () => {
    expect(merged({ base: {}, remote: {}, run: {} })).toEqual({});
  });

  test('an empty base degrades to a 2-way union instead of failing', () => {
    expect(
      merged({
        base: undefined,
        remote: { lastSync: '2026-08-06T00:00:00Z' },
        run: { lastSync: '2026-08-07T00:00:00Z' },
      })
    ).toEqual({ lastSync: '2026-08-07T00:00:00Z' });
  });
});

test.describe('a malformed side fails loudly — never silently', () => {
  for (const [label, bad] of [
    ['a bare string', '"not an object"'],
    ['an array', ['lastSync']],
    ['null', null],
    ['a number', 7],
  ] as Array<[string, unknown]>) {
    test(`remote is ${label} -> throws`, () => {
      expect(() => merged({ base: {}, remote: bad, run: { lastSync: '2026-08-07T00:00:00Z' } })).toThrow(
        /is not a JSON object/
      );
    });

    test(`run is ${label} -> throws`, () => {
      expect(() => merged({ base: {}, remote: { lastSync: '2026-08-07T00:00:00Z' }, run: bad })).toThrow(
        /is not a JSON object/
      );
    });
  }

  test('a malformed BASE is tolerated (it only attributes changes) — the sides still merge', () => {
    // The module's CLI turns an unparseable stage 1 into `{}` with a
    // ::warning:: rather than throwing away the run's paid work; the pure
    // function accepts the same degradation. Safety is preserved because every
    // both-moved non-timestamp key still throws (see below).
    expect(
      merged({
        base: {},
        remote: { lastSync: '2026-08-06T00:00:00Z' },
        run: { lastSync: '2026-08-07T00:00:00Z' },
      })
    ).toEqual({ lastSync: '2026-08-07T00:00:00Z' });
  });
});

test.describe('a key neither side knew about', () => {
  test('a base-only key both sides dropped stays dropped, without throwing', () => {
    const out = merged({
      base: { retired: 'gone', lastSync: '2026-08-01T00:00:00Z' },
      remote: { lastSync: '2026-08-06T00:00:00Z' },
      run: { lastSync: '2026-08-07T00:00:00Z' },
    });
    expect(out).toEqual({ lastSync: '2026-08-07T00:00:00Z' });
    expect(out).not.toHaveProperty('retired');
  });

  test('a key only the BASE and one side know is carried by that side', () => {
    const out = merged({
      base: { keep: 'v', lastSync: '2026-08-01T00:00:00Z' },
      remote: { keep: 'v', lastSync: '2026-08-01T00:00:00Z' },
      run: { keep: 'v', lastSync: '2026-08-07T00:00:00Z' },
    });
    expect(out.keep).toBe('v');
  });
});

test.describe('the 3-way payoff: an echo never beats a real edit', () => {
  test("a PR's rewritten note survives the sync's stale echo of the old one", () => {
    // Both writers load the whole state and write it back, so the run's commit
    // carries a copy of whatever `note` said when it started. A 2-way "run
    // wins" union would silently revert the PR. This is the case that rule
    // exists for.
    const base = { lastSync: '2026-08-06T00:00:00Z', note: 'old note' };
    const out = merged({
      base,
      remote: { lastSync: '2026-08-06T00:00:00Z', note: 'REWRITTEN by a PR' },
      run: { lastSync: '2026-08-07T00:00:00Z', note: 'old note' },
    });
    expect(out.note).toBe('REWRITTEN by a PR');
    expect(out.lastSync).toBe('2026-08-07T00:00:00Z');
  });

  test('a deliberate key deletion on main is honored, not undone by the echo', () => {
    const out = merged({
      base: { lastSync: '2026-08-06T00:00:00Z', note: 'obsolete' },
      remote: { lastSync: '2026-08-06T00:00:00Z' },
      run: { lastSync: '2026-08-07T00:00:00Z', note: 'obsolete' },
    });
    expect(out).not.toHaveProperty('note');
    expect(out.lastSync).toBe('2026-08-07T00:00:00Z');
  });
});

test.describe('anything not deterministically resolvable throws', () => {
  test('both sides rewrote the note differently -> no union exists', () => {
    expect(() =>
      merged({
        base: { note: 'old' },
        remote: { note: 'main rewrote it' },
        run: { note: 'the run rewrote it' },
      })
    ).toThrow(/changed on BOTH sides/);
  });

  test('both sides changed a nested value -> throws rather than guessing', () => {
    expect(() =>
      merged({
        base: { cfg: { a: 1 } },
        remote: { cfg: { a: 2 } },
        run: { cfg: { a: 3 } },
      })
    ).toThrow(/changed on BOTH sides/);
  });

  test('one side deleted a key the other rewrote -> throws', () => {
    expect(() =>
      merged({ base: { note: 'old' }, remote: {}, run: { note: 'new' } })
    ).toThrow(/changed on BOTH sides/);
  });

  test('an identical edit on both sides is NOT a conflict', () => {
    expect(merged({ base: { note: 'old' }, remote: { note: 'same' }, run: { note: 'same' } })).toEqual({
      note: 'same',
    });
  });
});

test.describe('isTimestamp is strict — prose is never mistaken for a cursor', () => {
  for (const good of [
    '2026-08-07T15:53:11Z',
    '2026-08-07T15:53:11.902Z',
    '2026-08-07T15:53:11+02:00',
  ]) {
    test(`accepts ${good}`, () => expect(isTimestamp(good)).toBe(true));
  }

  for (const bad of [
    '2026-08-07', // bare date — outage #1's poisoned cursor shape
    'Cursor-format outage #2: the 2026-07-16 run …',
    '2026-08-07 15:53:11',
    '2026-13-45T99:99:99Z',
    '',
    5,
    null,
  ] as unknown[]) {
    test(`rejects ${JSON.stringify(bad)}`, () => expect(isTimestamp(bad)).toBe(false));
  }
});
