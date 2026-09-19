import { expect, test } from '@playwright/test';
import {
  DEFAULT_REDECODE_MAX_PER_NIGHT,
  countSaysNewText,
  dateSaysNewText,
  earliestVersionDate,
  planRedecodes,
  textVersionStamp,
  versionCount,
} from '../scripts/text-version.mjs';

/*
 * PINS the re-decode-on-new-text trigger: WHO gets re-read (dateSaysNewText,
 * with countSaysNewText as its free hint) and HOW MANY get paid for
 * (planRedecodes). See scripts/text-version.mjs for the full reasoning.
 *
 * THE FAILURE IT EXISTS FOR, live on 2026-09-18: H.R. 5634 was reported out
 * of committee WITH AN AMENDMENT on 2026-09-08, which moved the dollar figure
 * at the centre of its decode, and the site kept printing the introduced
 * number in both languages for ten days. Nothing was broken — the refresh
 * path updates a bill's status, date and urgency and never its explanation.
 *
 * Two of these tests are money tests, marked as such. If one fails, a nightly
 * Anthropic bill changed: re-derive the ceiling deliberately rather than
 * loosening the pin.
 */

const fmt = (url: string) => [{ type: 'PDF', url: url + '.pdf' }, { type: 'Formatted Text', url }];

/** hr/5634 exactly as api.congress.gov returned it on 2026-09-18 — the bill
 *  this trigger was built for: reported WITH an amendment on 2026-09-08 over
 *  a text introduced 2025-09-30, and decoded from the older one. */
function amendedVersions() {
  return [
    { type: 'Reported in House', date: '2026-09-08T04:00:00Z', formats: fmt('https://congress.gov/hr5634rh.htm') },
    { type: 'Introduced in House', date: '2025-09-30T04:00:00Z', formats: fmt('https://congress.gov/hr5634ih.htm') },
  ];
}

/** A bill Congress has published exactly once. */
function singleVersion() {
  return [
    { type: 'Introduced in House', date: '2025-09-30T04:00:00Z', formats: fmt('https://congress.gov/hr9ih.htm') },
  ];
}

/** hr/1's shape: the two terminal texts of an enacted bill sit outside the
 *  date order, and the FIRST entry carries no date at all. */
function enactedVersions() {
  return [
    { type: 'Enrolled Bill', date: null, formats: fmt('https://congress.gov/hr1enr.htm') },
    { type: 'Engrossed Amendment Senate', date: '2025-07-01T04:00:00Z', formats: fmt('https://congress.gov/hr1eas.htm') },
    { type: 'Public Law', date: '2025-07-05T03:59:59Z', formats: fmt('https://congress.gov/hr1enr-pl.htm') },
  ];
}

// ---------------------------------------------------------------------------
// 1. Candidate detection — the dated check, which is the only authority
// ---------------------------------------------------------------------------

test.describe('dateSaysNewText — has Congress replaced the text we explained', () => {
  test('a record decoded from the introduced text is a candidate once the bill is amended', () => {
    const v = dateSaysNewText({ storedDate: '2025-09-30T04:00:00Z', versions: amendedVersions() });
    expect(v.redecode).toBe(true);
    expect(v.reason).toBe('new-text-version');
    expect(v.from).toBe('2025-09-30T04:00:00Z');
    expect(v.to).toBe('2026-09-08T04:00:00Z');
  });

  test('a record already decoded from the current text is NOT a candidate — this is what closes the loop', () => {
    // The re-decode stamps the version it read, so the very next run must
    // reach this branch. If it ever stops doing so, the same bill is billed
    // one decode a night forever.
    const v = dateSaysNewText({ storedDate: '2026-09-08T04:00:00Z', versions: amendedVersions() });
    expect(v.redecode).toBe(false);
    expect(v.reason).toBe('current-text-decoded');
  });

  test('a LEGACY record (no stamp) on a multi-version bill is a candidate — the backfill', () => {
    // The whole pre-2026-09-18 corpus has no stamp. Treating it as decoded
    // from the EARLIEST version is an assumption, and the conservative one:
    // it over-triggers a re-read rather than letting a stale explanation
    // stand. hr-5634-119 is exactly this case today.
    const v = dateSaysNewText({ storedDate: null, versions: amendedVersions() });
    expect(v.redecode).toBe(true);
    expect(v.reason).toBe('legacy-backfill');
    expect(v.from).toBe('2025-09-30T04:00:00Z');
  });

  test('a LEGACY record on a single-version bill is NOT a candidate', () => {
    // MONEY: 2,717 of the corpus's records carry no stamp. If this branch
    // ever flipped, every one of them would queue for a paid re-decode.
    const v = dateSaysNewText({ storedDate: null, versions: singleVersion() });
    expect(v.redecode).toBe(false);
    expect(v.reason).toBe('legacy-no-newer-text');
  });

  test('a current version with no date yields no verdict rather than a guess', () => {
    // Congress.gov pins `Enrolled Bill` first and dates it null.
    expect(dateSaysNewText({ storedDate: null, versions: enactedVersions() })).toEqual({
      redecode: false,
      reason: 'no-dated-text',
    });
  });

  test('the comparison is against the version we can READ, not textVersions[0]', () => {
    // A newest entry with no Formatted Text is skipped by pickTextVersion, so
    // a decode reads (and stamps) the one below it. Measuring against the
    // unreadable entry would leave the bill a candidate after its own
    // re-decode — a decode billed every night for a document nobody can read.
    const versions = [
      { type: 'Reported in House', date: '2026-09-08T04:00:00Z', formats: [{ type: 'PDF', url: 'x.pdf' }] },
      ...singleVersion(),
    ];
    const stamped = dateSaysNewText({ storedDate: '2025-09-30T04:00:00Z', versions });
    expect(stamped.redecode).toBe(false);
    expect(stamped.reason).toBe('current-text-decoded');
  });

  test('missing or unusable inputs decide nothing', () => {
    expect(dateSaysNewText({ storedDate: null, versions: [] }).redecode).toBe(false);
    expect(dateSaysNewText({ storedDate: null, versions: null }).reason).toBe('no-versions');
    expect(dateSaysNewText({}).redecode).toBe(false);
    expect(
      dateSaysNewText({ storedDate: 'not a date', versions: amendedVersions() })
    ).toEqual({ redecode: false, reason: 'unparseable-date' });
  });

  test('earliestVersionDate returns the oldest dated entry, ignoring undated ones', () => {
    expect(earliestVersionDate(amendedVersions())).toBe('2025-09-30T04:00:00Z');
    expect(earliestVersionDate(enactedVersions())).toBe('2025-07-01T04:00:00Z');
    expect(earliestVersionDate([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The free hint — a nomination for a probe, never a decision to spend
// ---------------------------------------------------------------------------

test.describe('countSaysNewText — the free bill-detail signal', () => {
  test('a grown count nominates the bill', () => {
    expect(countSaysNewText({ storedCount: 1, servedCount: 2 })).toMatchObject({
      newer: true,
      reason: 'count-grew',
    });
  });

  test('an unchanged or shrunken count nominates nothing', () => {
    expect(countSaysNewText({ storedCount: 2, servedCount: 2 }).newer).toBe(false);
    expect(countSaysNewText({ storedCount: 3, servedCount: 2 }).newer).toBe(false);
  });

  test('a null on either side is "cannot tell", never "yes"', () => {
    // Number(null) is 0, so a naive implementation reads every legacy record
    // (no stored count) as a bill that just gained its entire text history —
    // which would nominate the whole corpus on the first night.
    expect(countSaysNewText({ storedCount: null, servedCount: 2 }).newer).toBe(false);
    expect(countSaysNewText({ storedCount: 2, servedCount: null }).newer).toBe(false);
    expect(countSaysNewText({}).newer).toBe(false);
    expect(countSaysNewText({ storedCount: 'two', servedCount: 3 }).newer).toBe(false);
  });

  test('versionCount prefers the reply’s own count over a paginated array length', () => {
    // cg() fetches /text with no `limit`, so a short array beside a larger
    // reported count is a page, not a shrinking bill. Comparing an array
    // length against the detail payload’s count would read as "new version"
    // on every run, forever.
    expect(versionCount({ pagination: { count: 25 }, textVersions: new Array(20).fill({}) })).toBe(25);
    expect(versionCount({ textVersions: amendedVersions() })).toBe(2);
    expect(versionCount(amendedVersions())).toBe(2);
    expect(versionCount({})).toBeNull();
  });

  test('textVersionStamp records the document read, and nothing it did not observe', () => {
    expect(textVersionStamp(amendedVersions()[0], 2)).toEqual({
      text_version_date: '2026-09-08T04:00:00Z',
      text_version_type: 'Reported in House',
      text_version_count: 2,
    });
    expect(textVersionStamp(null, null)).toEqual({
      text_version_date: null,
      text_version_type: null,
      text_version_count: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The cap — the money ceiling
// ---------------------------------------------------------------------------

test.describe('planRedecodes — how many re-decodes a night may pay for', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ slug: `hr-${i + 1}-119`, reason: 'new-text-version' }));

  test('the default ceiling is 10 a night', () => {
    // MONEY: 10 x ~$0.065 = ~$0.65/night worst case. Changing this number
    // changes the nightly bill linearly.
    expect(DEFAULT_REDECODE_MAX_PER_NIGHT).toBe(10);
  });

  test('a night with more candidates than the cap pays for the cap and defers the rest', () => {
    const plan = planRedecodes({ detected: many(25) });
    expect(plan.run).toHaveLength(10);
    expect(plan.deferred).toHaveLength(15);
    expect(plan.run[0].slug).toBe('hr-1-119');
  });

  test('forced slugs jump the queue but do NOT raise the ceiling', () => {
    // FORCE_REDECODE_SLUGS is an owner order about PRIORITY, not about spend.
    // A fifty-slug list must cost ten re-decodes tonight, not fifty.
    const forced = Array.from({ length: 50 }, (_, i) => `s-${i + 1}-119`);
    const plan = planRedecodes({ forced, detected: many(5) });
    expect(plan.run).toHaveLength(10);
    expect(plan.run.every((r) => r.reason === 'forced')).toBe(true);
    expect(plan.run[0].slug).toBe('s-1-119');
    expect(plan.deferred).toHaveLength(45);
  });

  test('a slug listed twice, or forced and also detected, is re-decoded once', () => {
    const plan = planRedecodes({
      forced: ['hr-5634-119', 'HR-5634-119'],
      detected: [{ slug: 'hr-5634-119', reason: 'legacy-backfill' }, { slug: 'hr-7-119' }],
    });
    expect(plan.run.map((r) => r.slug)).toEqual(['hr-5634-119', 'hr-7-119']);
    expect(plan.run[0].reason).toBe('forced');
  });

  test('an unusable cap falls back to the default rather than to NaN or to nothing', () => {
    // `slice(0, NaN)` returns [], which would make a typo'd env var look
    // exactly like a quiet night with nothing to re-read.
    expect(planRedecodes({ detected: many(25), cap: Number.NaN }).cap).toBe(10);
    expect(planRedecodes({ detected: many(25), cap: -3 }).cap).toBe(10);
    expect(planRedecodes({ detected: many(25), cap: 3 }).run).toHaveLength(3);
    expect(planRedecodes({ detected: many(25), cap: 0 }).run).toHaveLength(0);
  });

  test('a bill amended since our stamp is never crowded out by the unstamped backfill', () => {
    // Almost the whole corpus is legacy, and at the top of the urgency order
    // nearly all of it qualifies as backfill (23 of 26 measured 2026-09-18).
    // Ranking on urgency alone would spend all ten slots on "might have been
    // decoded from an older text" and defer the one bill we WATCHED get a new
    // text — the backfill crowding out the signal it exists to serve.
    const plan = planRedecodes({
      detected: [
        ...Array.from({ length: 12 }, (_, i) => ({
          slug: `s-${i + 1}-119`,
          reason: 'legacy-backfill',
          urgency: 1,
        })),
        { slug: 'hr-5634-119', reason: 'new-text-version', urgency: 0.4 },
      ],
    });
    expect(plan.run[0].slug).toBe('hr-5634-119');
    expect(plan.run).toHaveLength(10);
    expect(plan.deferred.every((r) => r.reason === 'legacy-backfill')).toBe(true);
  });

  test('within a tier, the more urgent bill is re-read first', () => {
    const plan = planRedecodes({
      cap: 2,
      detected: [
        { slug: 's-1-119', reason: 'legacy-backfill', urgency: 0.2 },
        { slug: 's-2-119', reason: 'legacy-backfill', urgency: 0.95 },
        { slug: 's-3-119', reason: 'legacy-backfill', urgency: 0.6 },
      ],
    });
    expect(plan.run.map((r) => r.slug)).toEqual(['s-2-119', 's-3-119']);
  });

  test('a quiet night plans nothing', () => {
    expect(planRedecodes({}).run).toHaveLength(0);
    expect(planRedecodes({ forced: [''], detected: [{ slug: '' }] }).run).toHaveLength(0);
  });
});
