import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// The outlet floor (owner ruling 2026-09-26): press is counted and named from
// AllSides-rated outlets only, with room for an owner-approved allowlist that
// does not exist yet. Pure module, no filesystem — every branch driven here.
import {
  MEDIA_BIAS_PATH,
  PRESS_ALLOWLIST_PATH,
  loadPressOutletPolicy,
  normalizeSource,
  parsePressAllowlist,
  pressOutletPolicy,
} from '../lib/press-outlets.mjs';
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

  test('no allowlist today: nothing is allowlisted and nothing is wrong', () => {
    expect(policy.allowlistSize).toBe(0);
    expect(policy.problems).toEqual([]);
  });
});

test.describe('the allowlist hook (for a later owner trial — no file ships)', () => {
  test('there is no data/press-allowlist.json in the repo', () => {
    expect(() => readFileSync(join(process.cwd(), PRESS_ALLOWLIST_PATH))).toThrow();
  });

  test('an allowlisted unrated outlet is admitted but carries NO lean', () => {
    const policy = pressOutletPolicy({
      ratings: RATINGS,
      allowlist: { outlets: { 'rollcall.com': { name: 'Roll Call', approved_on: '2026-10-01' } } },
    });
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

  test('a malformed allowlist fails CLOSED — rated-only, with the reason reported', () => {
    for (const bad of [
      [],
      'rollcall.com',
      { outlets: ['rollcall.com'] },
      { outlets: null },
      { domains: { 'rollcall.com': {} } },
    ]) {
      const policy = pressOutletPolicy({ ratings: RATINGS, allowlist: bad });
      expect(policy.admits('rollcall.com'), JSON.stringify(bad)).toBe(false);
      expect(policy.problems.length, JSON.stringify(bad)).toBeGreaterThan(0);
      expect(policy.admits('foxnews.com')).toBe(true);
    }
  });

  test('one bad key rejects the WHOLE list — an approved list is approved as a list', () => {
    const parsed = parsePressAllowlist({
      outlets: { 'rollcall.com': { name: 'Roll Call' }, 'https://www.punchbowl.news/': { name: 'Punchbowl' }, 'Axios.com': { name: 'Axios' } },
    });
    expect(parsed.domains.size).toBe(0);
    expect(parsed.problems).toHaveLength(2);
    const policy = pressOutletPolicy({
      ratings: RATINGS,
      allowlist: { outlets: { 'rollcall.com': { name: 'Roll Call' }, 'WWW.x.com': { name: 'X' } } },
    });
    expect(policy.admits('rollcall.com')).toBe(false);
  });

  test('every entry must name its masthead — no name, and the whole list fails closed', () => {
    // Without it a named outlet would print under the capitalised-domain
    // fallback ("Enr", "Pymnts") on a Big Question timeline.
    for (const entry of [{}, { approved_on: '2026-10-01' }, { name: '' }, { name: '   ' }, { name: 7 }, null]) {
      const policy = pressOutletPolicy({
        ratings: RATINGS,
        allowlist: { outlets: { 'rollcall.com': { name: 'Roll Call' }, 'enr.com': entry } },
      });
      expect(policy.admits('enr.com'), JSON.stringify(entry)).toBe(false);
      expect(policy.admits('rollcall.com'), JSON.stringify(entry)).toBe(false);
      expect(policy.problems.join(' '), JSON.stringify(entry)).toContain('"enr.com" has no "name"');
    }
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

  test('loadPressOutletPolicy: a present, valid allowlist is honored', () => {
    const files: Record<string, unknown> = {
      [MEDIA_BIAS_PATH]: { outlets: RATINGS },
      [PRESS_ALLOWLIST_PATH]: { outlets: { 'rollcall.com': { name: 'Roll Call', approved_on: '2026-10-01' } } },
    };
    const policy = loadPressOutletPolicy({ readJSON: (p) => files[p], exists: (p) => p in files });
    expect(policy.admits('rollcall.com')).toBe(true);
    expect(policy.problems).toEqual([]);
  });

  test('loadPressOutletPolicy: unparseable allowlist JSON fails closed and says why', () => {
    const policy = loadPressOutletPolicy({
      readJSON: (p) => {
        if (p === PRESS_ALLOWLIST_PATH) throw new SyntaxError('Unexpected token }');
        return { outlets: RATINGS };
      },
      exists: () => true,
    });
    expect(policy.admits('rollcall.com')).toBe(false);
    expect(policy.admits('foxnews.com')).toBe(true);
    expect(policy.problems[0]).toContain('not valid JSON');
  });

  test('loadPressOutletPolicy: no ratings file admits nothing (fails closed, never open)', () => {
    const policy = loadPressOutletPolicy({ readJSON: () => ({}), exists: () => false });
    expect(policy.admits('foxnews.com')).toBe(false);
  });
});

test.describe('normalizeSource is the Read section’s own matcher', () => {
  test('agrees with lib/coverage.ts on a shared table', () => {
    for (const s of ['cnn.com', 'https://www.foxnews.com/politics/x', 'WWW.NPR.ORG', ' http://thehill.com ', '', 'sana.sy/en/x']) {
      expect(normalizeSource(s), s).toBe(tsNormalizeSource(s));
    }
  });
});
