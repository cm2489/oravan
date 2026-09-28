import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// The outlet floor (owner ruling 2026-09-26): press is counted and named from
// AllSides-rated outlets only, plus an owner-approved allowlist whose every
// entry is dated and judged by the day (the trial proposal's P1, 2026-09-26).
// Pure module, no filesystem — every branch driven here.
import {
  MEDIA_BIAS_PATH,
  PRESS_ALLOWLIST_PATH,
  TRIAL_MAX_DAYS,
  etDayOf,
  isCalendarDay,
  loadPressOutletPolicy,
  normalizeSource,
  parsePressAllowlist,
  pressOutletPolicy,
} from '../lib/press-outlets.mjs';
import { etDay } from '../lib/moment-updates-gate.mjs';
import { normalizeSource as tsNormalizeSource } from '../lib/coverage';

const read = (p: string) => JSON.parse(readFileSync(join(process.cwd(), p), 'utf8'));
const RATINGS: Record<string, string> = read('data/media-bias.json').outlets;

test.describe('rated-only by default', () => {
  const policy = pressOutletPolicy({ ratings: RATINGS });

  test('an AllSides-rated outlet is admitted and carries its lean', () => {
    expect(policy.admits('foxnews.com')).toBe(true);
    expect(policy.leanOf('foxnews.com')).toBe('right');
    expect(policy.admits('https://www.cnn.com/politics/x')).toBe(true);
    expect(policy.leanOf('https://www.cnn.com/politics/x')).toBe('left');
    expect(policy.isRated('npr.org')).toBe(true);
  });

  test('the live unrated examples from Big Question vehicle pages are refused', () => {
    // 2026-09-25 corpus: s-4784, sjres-172 and s-3172 respectively.
    for (const d of ['thegatewaypundit.com', 'naturalnews.com', 'sana.sy']) {
      expect(policy.admits(d), d).toBe(false);
      expect(policy.isRated(d), d).toBe(false);
      expect(policy.leanOf(d), d).toBeNull();
    }
  });

  test('empty, missing and junk sources are refused, never admitted by accident', () => {
    for (const s of ['', '   ', null, undefined, 'unknown']) {
      expect(policy.admits(s as string)).toBe(false);
    }
  });

  test('a rating value outside the three leans does not count as rated', () => {
    const odd = pressOutletPolicy({ ratings: { 'weird.example': 'mixed' } });
    expect(odd.admits('weird.example')).toBe(false);
  });

  test('no allowlist: nothing is allowlisted and nothing is wrong', () => {
    expect(policy.allowlistSize).toBe(0);
    expect(policy.problems).toEqual([]);
  });
});

/** One dated entry; override any field (undefined deletes it). */
const entry = (over: Record<string, unknown> = {}) => {
  const e: Record<string, unknown> = {
    domain: 'rollcall.com',
    name: 'Roll Call',
    approved_on: '2026-09-28',
    trial_ends: '2026-10-11',
    status: 'active',
    ...over,
  };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
};
const list = (...entries: unknown[]) => ({ _note: 'test', outlets: entries });

test.describe('the allowlist hook: dated entries, judged by the day', () => {
  test('an allowlisted unrated outlet is admitted, on its days, but carries NO lean', () => {
    const policy = pressOutletPolicy({ ratings: RATINGS, allowlist: list(entry()), today: '2026-10-01' });
    expect(policy.problems).toEqual([]);
    expect(policy.admits('rollcall.com')).toBe(true);
    expect(policy.allowlistName('https://www.rollcall.com/x')).toBe('Roll Call');
    expect(policy.allowlistName('foxnews.com')).toBeNull();
    expect(policy.isAllowlisted('https://www.rollcall.com/x')).toBe(true);
    expect(policy.isRated('rollcall.com')).toBe(false);
    expect(policy.leanOf('rollcall.com')).toBeNull();
    expect(policy.allowlistSize).toBe(1);
    // It does not widen anything else.
    expect(policy.admits('thegatewaypundit.com')).toBe(false);
  });

  test('an entry admits from approved_on through trial_ends — both edges in, the day either side out', () => {
    const policy = pressOutletPolicy({ ratings: RATINGS, allowlist: list(entry()) });
    const on = (day: string) => policy.admits('rollcall.com', { on: day });
    expect(on('2026-09-27')).toBe(false);
    expect(on('2026-09-28')).toBe(true);
    expect(on('2026-10-04')).toBe(true);
    expect(on('2026-10-11')).toBe(true);
    expect(on('2026-10-12')).toBe(false);
    expect(on('2027-01-01')).toBe(false);
    // A rated outlet is admitted on every day; the dates are the allowlist's alone.
    for (const d of ['2026-09-27', '2026-10-12']) expect(policy.admits('foxnews.com', { on: d })).toBe(true);
  });

  test('a list nobody renews goes back to rated-only by itself — no edit, no problem, no red', () => {
    const policy = pressOutletPolicy({ ratings: RATINGS, allowlist: list(entry()), today: '2026-10-12' });
    expect(policy.problems).toEqual([]);
    expect(policy.admits('rollcall.com')).toBe(false);
    expect(policy.allowlistSize).toBe(0);
    // History still reads: the days it ran are still its days.
    expect(policy.admits('rollcall.com', { on: '2026-10-11' })).toBe(true);
    expect(policy.allowlistName('rollcall.com')).toBe('Roll Call');
  });

  test('an undated question gets the rated-only answer, never an open one', () => {
    // No `today` and no `on`: the allowlist admits nothing.
    const policy = pressOutletPolicy({ ratings: RATINGS, allowlist: list(entry()) });
    expect(policy.today).toBeNull();
    expect(policy.admits('rollcall.com')).toBe(false);
    expect(policy.isAllowlisted('rollcall.com')).toBe(false);
    expect(policy.allowlistSize).toBe(0);
    expect(policy.admits('foxnews.com')).toBe(true);
    // A malformed `on` is judged as no day at all, never as `today`.
    const dated = pressOutletPolicy({ ratings: RATINGS, allowlist: list(entry()), today: '2026-10-01' });
    for (const bad of ['', '2026-10-01T12:00:00Z', '10/01/2026', '2026-02-30', null]) {
      expect(dated.admits('rollcall.com', { on: bad as string }), String(bad)).toBe(false);
    }
    // An explicit `on: undefined` is "no day given", so `today` answers.
    expect(dated.admits('rollcall.com', { on: undefined })).toBe(true);
    // Handed straight to Array#filter (the index arrives as the second
    // argument), the index is not mistaken for a day.
    const asFilter = dated.admits as unknown as (s: string, i: number) => boolean;
    expect(['rollcall.com', 'sana.sy'].filter(asFilter)).toEqual(['rollcall.com']);
  });

  test('an ended entry admits through ended_on and nothing after, even before trial_ends', () => {
    const policy = pressOutletPolicy({
      ratings: RATINGS,
      allowlist: list(entry({ status: 'ended', ended_on: '2026-10-03' })),
      today: '2026-10-05',
    });
    expect(policy.problems).toEqual([]);
    expect(policy.admits('rollcall.com', { on: '2026-09-28' })).toBe(true);
    expect(policy.admits('rollcall.com', { on: '2026-10-03' })).toBe(true);
    expect(policy.admits('rollcall.com', { on: '2026-10-04' })).toBe(false);
    expect(policy.admits('rollcall.com')).toBe(false);
    expect(policy.entries()[0]).toMatchObject({
      status: 'ended',
      ended_on: '2026-10-03',
      last_day: '2026-10-03',
      in_force_today: false,
    });
  });

  test('a renewal is a new entry: both windows admit, the gap between them does not', () => {
    const policy = pressOutletPolicy({
      ratings: RATINGS,
      allowlist: list(
        entry({ status: 'ended', ended_on: '2026-10-11' }),
        entry({ approved_on: '2026-10-20', trial_ends: '2026-11-18' }),
      ),
    });
    expect(policy.problems).toEqual([]);
    expect(policy.admits('rollcall.com', { on: '2026-10-11' })).toBe(true);
    expect(policy.admits('rollcall.com', { on: '2026-10-15' })).toBe(false);
    expect(policy.admits('rollcall.com', { on: '2026-10-20' })).toBe(true);
    expect(policy.admits('rollcall.com', { on: '2026-11-18' })).toBe(true);
    expect(policy.admits('rollcall.com', { on: '2026-11-19' })).toBe(false);
  });

  test('the 30-day ceiling: 30 days past approved_on is allowed, 31 fails the list closed', () => {
    expect(TRIAL_MAX_DAYS).toBe(30);
    const ok = pressOutletPolicy({ ratings: RATINGS, allowlist: list(entry({ trial_ends: '2026-10-28' })) });
    expect(ok.problems).toEqual([]);
    const long = pressOutletPolicy({
      ratings: RATINGS,
      allowlist: list(entry({ trial_ends: '2026-10-29' })),
      today: '2026-10-01',
    });
    expect(long.admits('rollcall.com')).toBe(false);
    expect(long.problems.join(' ')).toContain('31 days after');
  });

  test('missing, malformed or impossible dates fail the WHOLE list closed, with the reason', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ approved_on: undefined }, '"approved_on" must be a real day'],
      [{ trial_ends: undefined }, '"trial_ends" must be a real day'],
      [{ trial_ends: '' }, '"trial_ends" must be a real day'],
      [{ trial_ends: '2026-10-11T00:00:00Z' }, '"trial_ends" must be a real day'],
      [{ approved_on: '2026-02-30', trial_ends: '2026-03-10' }, '"approved_on" must be a real day'],
      [{ approved_on: '2026-10-12' }, 'is before "approved_on"'],
      [{ status: undefined }, '"status" must be one of'],
      [{ status: 'paused' }, '"status" must be one of'],
      [{ status: 'ended' }, 'needs "ended_on"'],
      [{ status: 'ended', ended_on: '2026-10-12' }, 'must fall between'],
      [{ status: 'ended', ended_on: '2026-09-27' }, 'must fall between'],
      [{ ended_on: '2026-10-01' }, 'only for an "ended" entry'],
      // A typo must never leave a list that looks dated but is not.
      [{ trial_ends: undefined, trial_end: '2026-10-11' }, 'does not know: trial_end'],
      [{ expires: '2026-10-11' }, 'does not know: expires'],
      [{ topics: 'defense' }, '"topics" must be a list'],
      [{ reason: 7 }, '"reason" must be text'],
    ];
    for (const [over, why] of cases) {
      const policy = pressOutletPolicy({
        ratings: RATINGS,
        allowlist: list(
          entry({ domain: 'federalnewsnetwork.com', name: 'Federal News Network' }),
          entry({ ...over, domain: 'enr.com', name: 'ENR' }),
        ),
        today: '2026-10-01',
      });
      const label = JSON.stringify(over);
      expect(policy.problems.join(' '), label).toContain(why);
      // Whole list: the sound entry beside it is refused too.
      expect(policy.admits('federalnewsnetwork.com'), label).toBe(false);
      expect(policy.admits('enr.com'), label).toBe(false);
      expect(policy.admits('foxnews.com'), label).toBe(true);
      expect(policy.allowlistSize, label).toBe(0);
    }
  });

  test('the keyed-by-domain form (no dates) is refused whole, and says why', () => {
    const legacy = { outlets: { 'rollcall.com': { name: 'Roll Call', approved_on: '2026-10-01' } } };
    const parsed = parsePressAllowlist(legacy);
    expect(parsed.domains.size).toBe(0);
    expect(parsed.problems[0]).toContain('keyed-by-domain form carried no trial dates');
    expect(pressOutletPolicy({ ratings: RATINGS, allowlist: legacy, today: '2026-10-01' }).admits('rollcall.com')).toBe(false);
  });

  test('a malformed allowlist fails CLOSED — rated-only, with the reason reported', () => {
    for (const bad of [[], 'rollcall.com', { outlets: null }, { outlets: ['rollcall.com'] }, { domains: [entry()] }, list(null)]) {
      const policy = pressOutletPolicy({ ratings: RATINGS, allowlist: bad, today: '2026-10-01' });
      expect(policy.admits('rollcall.com'), JSON.stringify(bad)).toBe(false);
      expect(policy.problems.length, JSON.stringify(bad)).toBeGreaterThan(0);
      expect(policy.admits('foxnews.com')).toBe(true);
    }
  });

  test('one bad domain rejects the WHOLE list — an approved list is approved as a list', () => {
    const parsed = parsePressAllowlist(
      list(
        entry(),
        entry({ domain: 'https://www.punchbowl.news/', name: 'Punchbowl' }),
        entry({ domain: 'Axios.com', name: 'Axios' }),
      ),
    );
    expect(parsed.domains.size).toBe(0);
    expect(parsed.entries).toEqual([]);
    expect(parsed.problems).toHaveLength(2);
  });

  test('every entry must name its masthead — no name, and the whole list fails closed', () => {
    // Without it a named outlet would print under the capitalised-domain
    // fallback ("Enr", "Pymnts") on a Big Question timeline.
    for (const name of [undefined, '', '   ', 7, null]) {
      const policy = pressOutletPolicy({
        ratings: RATINGS,
        allowlist: list(entry(), entry({ domain: 'enr.com', name })),
        today: '2026-10-01',
      });
      expect(policy.admits('enr.com'), JSON.stringify(name)).toBe(false);
      expect(policy.admits('rollcall.com'), JSON.stringify(name)).toBe(false);
      expect(policy.problems.join(' '), JSON.stringify(name)).toContain('"enr.com" has no "name"');
    }
  });

  test('two entries for one domain must not share a day, and must share a name', () => {
    const overlap = parsePressAllowlist(list(entry(), entry({ approved_on: '2026-10-11', trial_ends: '2026-10-20' })));
    expect(overlap.problems.join(' ')).toContain('share days');
    const twin = parsePressAllowlist(list(entry(), entry()));
    expect(twin.problems.join(' ')).toContain('share days');
    const renamed = parsePressAllowlist(
      list(
        entry({ status: 'ended', ended_on: '2026-10-11' }),
        entry({ name: 'CQ Roll Call', approved_on: '2026-10-20', trial_ends: '2026-10-30' }),
      ),
    );
    expect(renamed.problems.join(' ')).toContain('more than one name');
  });

  test('validity never depends on the clock: the same file reads the same on any day', () => {
    const file = list(entry(), entry({ domain: 'pymnts.com', name: 'PYMNTS', status: 'ended', ended_on: '2026-10-02' }));
    for (const today of [undefined, '2026-01-01', '2026-10-01', '2027-12-31']) {
      const policy = pressOutletPolicy({ ratings: RATINGS, allowlist: file, today });
      expect(policy.problems, String(today)).toEqual([]);
    }
  });

  test('allowlistSize counts only the domains in force today; entries() is a copy with the day marked', () => {
    const policy = pressOutletPolicy({
      ratings: RATINGS,
      allowlist: list(
        entry(),
        entry({ domain: 'pymnts.com', name: 'PYMNTS', status: 'ended', ended_on: '2026-09-30' }),
        entry({ domain: 'coinworld.com', name: 'Coin World', approved_on: '2026-10-05', trial_ends: '2026-10-18' }),
      ),
      today: '2026-10-01',
    });
    expect(policy.allowlistSize).toBe(1);
    const rows = policy.entries();
    expect(rows.map((r) => [r.domain, r.in_force_today])).toEqual([
      ['rollcall.com', true],
      ['pymnts.com', false],
      ['coinworld.com', false],
    ]);
    rows[0].last_day = '2099-01-01';
    rows[0].topics.push('x');
    expect(policy.admits('rollcall.com', { on: '2026-10-12' })).toBe(false);
    expect(policy.entries()[0].topics).toEqual([]);
  });

  test('loadPressOutletPolicy: absent allowlist is rated-only with no problems', () => {
    const files: Record<string, unknown> = { [MEDIA_BIAS_PATH]: { outlets: RATINGS } };
    const policy = loadPressOutletPolicy({
      readJSON: (p) => files[p],
      exists: (p) => p in files,
    });
    expect(policy.admits('foxnews.com')).toBe(true);
    expect(policy.admits('rollcall.com')).toBe(false);
    expect(policy.problems).toEqual([]);
  });

  test('loadPressOutletPolicy: a present, valid allowlist is honored on its days; today defaults to the ET day now', () => {
    const files: Record<string, unknown> = {
      [MEDIA_BIAS_PATH]: { outlets: RATINGS },
      [PRESS_ALLOWLIST_PATH]: list(entry()),
    };
    const io = { readJSON: (p: string) => files[p], exists: (p: string) => p in files };
    const policy = loadPressOutletPolicy({ ...io, today: '2026-10-01' });
    expect(policy.admits('rollcall.com')).toBe(true);
    expect(policy.problems).toEqual([]);
    expect(loadPressOutletPolicy({ ...io, today: '2026-10-12' }).admits('rollcall.com')).toBe(false);
    expect(loadPressOutletPolicy(io).today).toBe(etDayOf());
  });

  test('loadPressOutletPolicy: unparseable allowlist JSON fails closed and says why', () => {
    const policy = loadPressOutletPolicy({
      readJSON: (p) => {
        if (p === PRESS_ALLOWLIST_PATH) throw new SyntaxError('Unexpected token }');
        return { outlets: RATINGS };
      },
      exists: () => true,
      today: '2026-10-01',
    });
    expect(policy.admits('rollcall.com')).toBe(false);
    expect(policy.admits('foxnews.com')).toBe(true);
    expect(policy.problems[0]).toContain('not valid JSON');
  });

  test('loadPressOutletPolicy: no ratings file admits nothing (fails closed, never open)', () => {
    const policy = loadPressOutletPolicy({ readJSON: () => ({}), exists: () => false });
    expect(policy.admits('foxnews.com')).toBe(false);
  });

  test('the committed data/press-allowlist.json, if there is one, is sound: dated, a list, none of it AllSides-rated', () => {
    // No file ships with the code; the owner adds it in his own pull request.
    // This test is what reads that file on that pull request — and
    // scripts/check-moment-updates.mjs reddens on the same problems.
    if (!existsSync(join(process.cwd(), PRESS_ALLOWLIST_PATH))) {
      expect(parsePressAllowlist(null).problems).toEqual([]);
      return;
    }
    const raw = read(PRESS_ALLOWLIST_PATH);
    expect(Array.isArray(raw.outlets)).toBe(true);
    const parsed = parsePressAllowlist(raw);
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries.length).toBe(raw.outlets.length);
    // An allowlisted outlet is by definition one AllSides does not rate here;
    // one it does rate belongs in data/media-bias.json with its lean instead.
    for (const e of parsed.entries) expect(RATINGS[e.domain], e.domain).toBeUndefined();
  });
});

test.describe('etDayOf is the pipeline’s legislative day', () => {
  test('agrees with lib/moment-updates-gate.mjs etDay across midnight and both DST edges', () => {
    const instants = [
      '2026-03-08T06:59:59Z',
      '2026-03-08T07:00:00Z',
      '2026-03-08T07:00:01Z',
      '2026-11-01T04:59:59Z',
      '2026-11-01T05:00:00Z',
      '2026-11-01T06:00:00Z',
      '2026-10-12T03:59:59Z',
      '2026-10-12T04:00:00Z',
      '2026-12-31T23:59:59Z',
      '2027-01-01T05:00:00Z',
    ];
    for (const iso of instants) {
      expect(etDayOf(iso), iso).toBe(etDay(iso));
      expect(etDayOf(Date.parse(iso)), iso).toBe(etDay(new Date(iso)));
    }
    expect(etDayOf('not a date')).toBe('');
  });

  test('a bare day is already a day: returned unchanged, as etDay does', () => {
    // Read as an instant, '2026-09-27' is UTC midnight — the evening of the
    // 26th in Washington. Both clocks must pass it through, or a caller that
    // hands over a publishedAt day is judged one day early.
    for (const day of ['2026-09-27', '2026-03-08', '2026-11-01', '2026-10-11', '2027-01-01']) {
      expect(etDayOf(day), day).toBe(day);
      expect(etDayOf(day), day).toBe(etDay(day));
    }
    // A timestamped string is still an instant, not a day.
    expect(etDayOf('2026-09-27T00:00:00Z')).toBe('2026-09-26');
    expect(etDayOf('2026-09-27T00:00:00Z')).toBe(etDay('2026-09-27T00:00:00Z'));
  });

  test('isCalendarDay refuses impossible days rather than rolling them over', () => {
    for (const ok of ['2026-02-28', '2028-02-29', '2026-12-31']) expect(isCalendarDay(ok), ok).toBe(true);
    for (const bad of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-01', '', null, 20261001]) {
      expect(isCalendarDay(bad), String(bad)).toBe(false);
    }
  });
});

test.describe('normalizeSource is the Read section’s own matcher', () => {
  test('agrees with lib/coverage.ts on a shared table', () => {
    for (const s of ['cnn.com', 'https://www.foxnews.com/politics/x', 'WWW.NPR.ORG', ' http://thehill.com ', '', 'sana.sy/en/x']) {
      expect(normalizeSource(s), s).toBe(tsNormalizeSource(s));
    }
  });
});
