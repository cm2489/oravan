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
import { buildSummaryPrompt, redecodeBill, textFingerprint } from '../scripts/bill-decode.mjs';

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

// ---------------------------------------------------------------------------
// 4. The fingerprint veto: the LAST gate, and the thing that closes the loop
// ---------------------------------------------------------------------------

test.beforeAll(() => {
  process.env.CONGRESS_API_KEY ??= 'test-key-never-sent-anywhere';
});

const VETO_TEXT = 'SEC. 1. SHORT TITLE. This Act may be cited as the Bridge Act.';

/** Congress.gov's /text endpoint plus the document behind it, serving the
 *  AMENDED version of hr/5634 — the shape this whole trigger exists for. */
function stubAmendedText(body: string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes('api.congress.gov')) {
      return new Response(JSON.stringify({ textVersions: amendedVersions() }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(`<html><body>${body}</body></html>`, { status: 200 });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function corpusBill(overrides: Record<string, unknown> = {}) {
  return {
    full_identifier: 'hr-5634-119',
    bill_type: 'hr',
    bill_number: 5634,
    title: 'An act to fund bridge repair.',
    ai_summary: 'The bill spends $4 billion.',
    ai_headline: 'Bridge money moves',
    ai_sections: { tldr: 't', what: 'w', who: 'o', why: 'y', cost: null, costChips: null },
    decoded_at: '2026-09-01T00:00:00Z',
    text_version_date: '2025-09-30T04:00:00Z',
    text_version_type: 'Introduced in House',
    text_version_count: 1,
    ...overrides,
  } as Record<string, unknown>;
}

test.describe('a VETOED re-decode stamps both provenance sets', () => {
  test('THE LIVE-LOCK: a nominated, probed, vetoed bill is not nominated again', async () => {
    // Before 2026-09-19 the veto wrote only `decode_text_verified_at`, which
    // #248's nominator does not read. So a bill whose text-version DATE had
    // moved but whose prompt had not — a new version of the same words, or a
    // version stamp this corpus never had — was nominated every night, spent a
    // free probe and a free /text fetch every night, and was vetoed every
    // night. Free in dollars, and permanent: the queue's ten slots were being
    // spent nominating bills that could never be re-decoded.
    const restore = stubAmendedText(VETO_TEXT);
    try {
      const bill = corpusBill();
      // The stored decode WAS written from this exact prompt.
      bill.decode_text_sha = textFingerprint(buildSummaryPrompt(bill, VETO_TEXT));

      // Night 1: #248 nominates it — its stamp names the introduced text and
      // Congress now serves a newer one.
      const nominated = dateSaysNewText({
        storedDate: bill.text_version_date as string,
        versions: amendedVersions(),
      });
      expect(nominated.redecode).toBe(true);
      expect(nominated.reason).toBe('new-text-version');

      // The fingerprint refuses the spend. A client that throws proves it.
      const anthropic = {
        messages: {
          create: async () => { throw new Error('a model call was made on an identical prompt'); },
        },
      };
      const result = await redecodeBill('hr-5634-119', {
        anthropic, es: {}, bySlug: new Map([['hr-5634-119', bill]]),
      });
      expect(result.outcome).toBe('text-unchanged');
      expect(result.decodeAttempted).toBe(false);

      // BOTH SETS ARE STAMPED — the version just read, not just the date we
      // read it on.
      expect(bill.text_version_date).toBe('2026-09-08T04:00:00Z');
      expect(bill.text_version_type).toBe('Reported in House');
      expect(bill.text_version_count).toBe(2);
      expect(typeof bill.decode_text_verified_at).toBe('string');
      // ...and the decode itself is untouched, because none was written.
      expect(bill.decoded_at).toBe('2026-09-01T00:00:00Z');
      expect(bill.ai_summary).toBe('The bill spends $4 billion.');

      // Night 2: the same nominator, over the updated record. Silent.
      const again = dateSaysNewText({
        storedDate: bill.text_version_date as string,
        versions: amendedVersions(),
      });
      expect(again.redecode).toBe(false);
      expect(again.reason).toBe('current-text-decoded');
    } finally {
      restore();
    }
  });

  test('the veto never fires on a document that really moved', async () => {
    // The guarantee that makes the veto safe: it declines to PAY, never to
    // re-READ. A changed document changes the prompt and the spend happens.
    const restore = stubAmendedText(`${VETO_TEXT} SEC. 2. The amount is $6,000,000,000.`);
    try {
      const bill = corpusBill();
      bill.decode_text_sha = textFingerprint(buildSummaryPrompt(bill, VETO_TEXT));
      let calls = 0;
      const anthropic = {
        messages: {
          create: async () => {
            calls++;
            return {
              content: [{
                type: 'text',
                text: calls === 1 ? 'A new summary.' : [
                  '[HEADLINE_EN]\nH', '[HEADLINE_ES]\nH', '[TLDR]\nT', '[WHAT]\nW', '[WHO]\nO',
                  '[WHY]\nY', '[COST]\nNONE', '[COST_CHIPS]\nNONE', '[ES_TLDR]\nT', '[ES_WHAT]\nW',
                  '[ES_WHO]\nO', '[ES_WHY]\nY', '[ES_COST]\nNONE', '[ES_COST_CHIPS]\nNONE',
                  '[ES_SUMMARY]\nR',
                ].join('\n'),
              }],
            };
          },
        },
      };
      const result = await redecodeBill('hr-5634-119', {
        anthropic, es: {}, bySlug: new Map([['hr-5634-119', bill]]),
      });
      expect(result.outcome).toBe('redecoded');
      expect(calls).toBe(2);
      expect(bill.text_version_date).toBe('2026-09-08T04:00:00Z');
      expect(bill.text_version_count).toBe(2);
    } finally {
      restore();
    }
  });
});
