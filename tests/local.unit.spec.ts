import { expect, test } from '@playwright/test';
import {
  isCallRecord,
  isReadRecord,
  sanitizeCalls,
  sanitizePrefs,
  sanitizeReads,
} from '../lib/local';

/*
 * THE LOCAL-STORE GUARDS, on their own — no React, no window, no server.
 * lib/local.ts's module body is window-guarded precisely so it can be read
 * like this, and these guards are the whole reason /record can be handed a
 * damaged store without going blank.
 *
 * The rule these tests exist to hold: FILTER, NEVER REJECT. Every "the bad
 * row is gone" assertion below is paired with a "the good rows are still
 * here" one, because a guard that threw the array away on the first
 * unreadable element would pass the first half alone — and erasing a
 * reader's civic record to protect them from a render error is a worse
 * outcome than the error was.
 */

const CALL = {
  billSlug: 'sjres-99-119',
  billLabel: 'S.J.Res. 99',
  repBioguide: 'D000399',
  repName: 'Monica De La Cruz',
  stance: 'support',
  outcome: 'contact',
  at: '2026-07-01T12:00:00.000Z',
};
const CALL_2 = { ...CALL, billSlug: 'hr-6500-119', at: '2026-07-02T12:00:00.000Z' };
const READ = { billSlug: 'sjres-99-119', billLabel: 'S.J.Res. 99', at: '2026-07-01T12:00:00.000Z' };
const READ_2 = { ...READ, billSlug: 'hr-6500-119', at: '2026-07-02T12:00:00.000Z' };

/* Every syntactically-valid JSON value that is not a list of rows. These are
   the four shapes lib/local.ts's own comment names as the ones that sailed
   through the original `as T` cast. */
const NOT_A_LIST = [null, 5, 'x', {}, true, undefined];

test.describe('isCallRecord', () => {
  test('keeps a row the record page can actually render', () => {
    expect(isCallRecord(CALL)).toBe(true);
    // The write-time bilingual labels are optional by design (rows written
    // before 2026-08 carry only `billLabel`) — an old row is not a bad row.
    expect(isCallRecord({ ...CALL, labelEn: 'S.J.Res. 99', labelEs: 'S.J.Res. 99' })).toBe(true);
  });

  test('refuses the shapes that throw downstream', () => {
    for (const bad of NOT_A_LIST) expect(isCallRecord(bad)).toBe(false);
    expect(isCallRecord([])).toBe(false);
    // A missing field is dereferenced unconditionally on /record.
    for (const key of ['billSlug', 'billLabel', 'repBioguide', 'repName', 'stance', 'outcome', 'at']) {
      const partial: Record<string, unknown> = { ...CALL };
      delete partial[key];
      expect(isCallRecord(partial), `a row missing "${key}" must not be kept`).toBe(false);
    }
    // `at` goes through Intl, which throws on a date it cannot parse — the
    // exact failure a plain typeof check would have let through.
    expect(isCallRecord({ ...CALL, at: 'not a date' })).toBe(false);
    expect(isCallRecord({ ...CALL, at: '' })).toBe(false);
    expect(isCallRecord({ ...CALL, at: 1751371200000 })).toBe(false);
    // Closed vocabularies: a value outside them is damage, not a dialect.
    expect(isCallRecord({ ...CALL, stance: 'neutral' })).toBe(false);
    expect(isCallRecord({ ...CALL, outcome: 'busy' })).toBe(false);
    // Inherited names are not own properties — `'toString' in OUTCOMES` is
    // true, and a guard written with `in` would have kept this row.
    expect(isCallRecord({ ...CALL, outcome: 'toString' })).toBe(false);
    expect(isCallRecord({ ...CALL, labelEs: 7 })).toBe(false);
    expect(isCallRecord({ ...CALL, billSlug: '' })).toBe(false);
  });
});

test.describe('isReadRecord', () => {
  test('keeps a readable row and refuses the rest', () => {
    expect(isReadRecord(READ)).toBe(true);
    expect(isReadRecord({ ...READ, labelEn: 'S.J.Res. 99' })).toBe(true);
    for (const bad of NOT_A_LIST) expect(isReadRecord(bad)).toBe(false);
    expect(isReadRecord({ billSlug: 'sjres-99-119' })).toBe(false);
    expect(isReadRecord({ ...READ, at: 'whenever' })).toBe(false);
    expect(isReadRecord({ ...READ, billSlug: '' })).toBe(false);
  });
});

test.describe('sanitizeCalls / sanitizeReads', () => {
  test('a list of nothing but damage sanitizes to an empty list, not to a throw', () => {
    expect(sanitizeCalls([null])).toEqual([]);
    expect(sanitizeReads([null])).toEqual([]);
    expect(sanitizeCalls([null, 5, 'x', {}])).toEqual([]);
    expect(sanitizeReads([null, 5, 'x', {}])).toEqual([]);
  });

  test('the readable rows around a bad one survive it', () => {
    expect(sanitizeCalls([CALL, null, CALL_2])).toEqual([CALL, CALL_2]);
    expect(sanitizeReads([READ, null, READ_2])).toEqual([READ, READ_2]);
    // Order is the record's meaning here — both lists are newest-first.
    expect(sanitizeCalls([CALL, null, CALL_2])?.map((c) => c.billSlug)).toEqual([
      CALL.billSlug,
      CALL_2.billSlug,
    ]);
  });

  test('a healthy list passes through untouched', () => {
    expect(sanitizeCalls([CALL, CALL_2])).toEqual([CALL, CALL_2]);
    expect(sanitizeReads([READ, READ_2])).toEqual([READ, READ_2]);
    expect(sanitizeCalls([])).toEqual([]);
  });

  test('anything that is not a list at all yields null, so the caller falls back', () => {
    // null is the coercer's "nothing salvageable here" — distinct from [],
    // which means "a list, and nothing in it was readable".
    for (const bad of NOT_A_LIST) {
      expect(sanitizeCalls(bad), `sanitizeCalls(${JSON.stringify(bad)})`).toBeNull();
      expect(sanitizeReads(bad), `sanitizeReads(${JSON.stringify(bad)})`).toBeNull();
    }
  });
});

test.describe('sanitizePrefs', () => {
  test('repairs the two known fields and leaves anything else alone', () => {
    expect(sanitizePrefs({ zip: '78501', interests: ['health'] })).toEqual({
      zip: '78501',
      interests: ['health'],
    });
    // A non-string zip and a non-array interests are dropped, not kept as
    // values every consumer would then call string/array methods on.
    expect(sanitizePrefs({ zip: 78501, interests: 5 })).toEqual({});
    expect(sanitizePrefs({ interests: ['health', null, 'education'] })).toEqual({
      interests: ['health', 'education'],
    });
    // Forward compatibility: setPrefs spreads the snapshot back out on every
    // write, so a field written by a newer build must survive an older one
    // reading it — dropping unknown keys here would quietly delete it.
    expect(sanitizePrefs({ zip: '78501', somethingNewer: true })).toEqual({
      zip: '78501',
      somethingNewer: true,
    });
  });

  test('anything that is not an object yields null', () => {
    for (const bad of [null, 5, 'x', true, undefined, []]) expect(sanitizePrefs(bad)).toBeNull();
  });
});
