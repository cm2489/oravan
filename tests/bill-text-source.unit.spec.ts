import { expect, test } from '@playwright/test';
import { pickTextVersion, syncOneBill } from '../scripts/bill-decode.mjs';

/*
 * PINS the two decode-truth guarantees in scripts/bill-decode.mjs:
 *
 *   1. A decode reads the CURRENT text of a bill. fetchBillText used to
 *      iterate `[...versions].reverse()` and take the LAST entry — and
 *      Congress.gov returns textVersions most-advanced-FIRST, so almost every
 *      bill still moving was decoded from the text as INTRODUCED, however far
 *      it had since travelled. hr-2701-119's shipped summary describes the
 *      introduced bill, not the amended calendar version visitors are being
 *      asked to call about.
 *
 *   2. A decode never happens at all without that text. On null, decode()
 *      substituted `bill.title` — one sentence of formal long title — and the
 *      model, unable to say "I was not given the bill", wrote what a bill of
 *      that name usually contains. sconres-39-119's shipped summary asserts
 *      what a budget resolution "typically" includes, as fact, about a
 *      document nobody read, under the same AI label a real decode carries.
 *
 * If one of these fails, a guarantee moved: re-derive it deliberately (and
 * update bill-decode.mjs's own comments) rather than loosening the pin.
 */

// A static import, like every other unit spec here: Playwright's loader can
// resolve the .mjs chain's named exports only when it transpiles the whole
// graph together, and a dynamic import() of the same modules fails on
// congress-fetch.mjs's exports. cg() reads CONGRESS_API_KEY per call rather
// than at module scope, so setting it here is early enough. No network is
// reached: globalThis.fetch is stubbed for every test that drives syncOneBill,
// and the key below is never sent anywhere.
test.beforeAll(() => {
  process.env.CONGRESS_API_KEY ??= 'test-key-never-sent-anywhere';
});

// ---------------------------------------------------------------------------
// 1. Which version we decode from
// ---------------------------------------------------------------------------

const fmt = (url: string) => [{ type: 'PDF', url: url + '.pdf' }, { type: 'Formatted Text', url }];

/** s/1199 exactly as the API returned it on 2026-08-09: most-advanced first. */
function inProgressVersions() {
  return [
    { type: 'Engrossed in Senate', date: '2026-04-29T04:00:00Z', formats: fmt('https://congress.gov/s1199es.htm') },
    { type: 'Reported to Senate', date: '2025-07-30T04:00:00Z', formats: fmt('https://congress.gov/s1199rs.htm') },
    { type: 'Introduced in Senate', date: '2025-03-27T04:00:00Z', formats: fmt('https://congress.gov/s1199is.htm') },
  ];
}

/** hr/1 exactly as the API returned it on 2026-08-09. The two terminal texts
 *  of an enacted bill sit OUTSIDE the date order: Enrolled is pinned first
 *  with a null date, Public Law is pinned last holding the newest date. */
function enactedVersions() {
  return [
    { type: 'Enrolled Bill', date: null, formats: fmt('https://congress.gov/hr1enr.htm') },
    { type: 'Engrossed Amendment Senate', date: '2025-07-01T04:00:00Z', formats: fmt('https://congress.gov/hr1eas.htm') },
    { type: 'Reported in House', date: '2025-05-20T04:00:00Z', formats: fmt('https://congress.gov/hr1rh.htm') },
    { type: 'Public Law', date: '2025-07-05T03:59:59Z', formats: fmt('https://congress.gov/hr1enr-pl.htm') },
  ];
}

test.describe('pickTextVersion — the current text, in the order Congress.gov returns', () => {
  test('an in-progress bill decodes from its newest version, not its introduced one', () => {
    const picked = pickTextVersion(inProgressVersions());
    expect(picked?.type).toBe('Engrossed in Senate');
    expect(picked?.date).toBe('2026-04-29T04:00:00Z');
  });

  test('the OLD reverse() took the last entry — the introduced text — which is the bug', () => {
    // Feeding the reversed array is exactly what the old loop iterated. Kept
    // as a pin because it names the failure in one line: same bill, same API
    // reply, a summary of a document 13 months out of date.
    const reversed = [...inProgressVersions()].reverse();
    expect(pickTextVersion(reversed)?.type).toBe('Introduced in Senate');
    // ...and the shipped order gives the version the bill is actually on.
    expect(pickTextVersion(inProgressVersions())?.type).toBe('Engrossed in Senate');
  });

  test('an enacted bill picks Enrolled — the final text — NOT the highest date', () => {
    // Verified live 2026-08-09: Enrolled first in 25/25 enacted bills, Public
    // Law last in 25/25. Sorting on `date` here would be a regression, not a
    // hardening: Enrolled's date is null and Public Law's is the newest.
    const picked = pickTextVersion(enactedVersions());
    expect(picked?.type).toBe('Enrolled Bill');
    expect(picked?.date).toBeNull();
    // The old reverse() landed on Public Law here — the right text, for the
    // wrong reason. That accident is why the damage never showed up in the
    // enacted records anyone spot-checked.
    expect(pickTextVersion([...enactedVersions()].reverse())?.type).toBe('Public Law');
  });

  test('a version with no Formatted Text URL is skipped, not treated as the end of the list', () => {
    const versions = [
      { type: 'Engrossed in Senate', date: '2026-04-29T04:00:00Z', formats: [{ type: 'PDF', url: 'https://congress.gov/x.pdf' }] },
      { type: 'Introduced in Senate', date: '2025-03-27T04:00:00Z', formats: fmt('https://congress.gov/s1199is.htm') },
    ];
    expect(pickTextVersion(versions)?.type).toBe('Introduced in Senate');
  });

  test('no versions at all is null — the signal that becomes the decode refusal', () => {
    expect(pickTextVersion([])).toBeNull();
    expect(pickTextVersion(undefined)).toBeNull();
    expect(pickTextVersion([{ type: 'Introduced in House', date: null, formats: [] }])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. syncOneBill end to end, with no network and no model
// ---------------------------------------------------------------------------

/** A gate-clearing Congress.gov bill-detail payload (floor_vote). */
const DETAIL = {
  title: 'A concurrent resolution setting forth the congressional budget for fiscal year 2027.',
  latestAction: { text: 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 550.', actionDate: '2026-08-05' },
  introducedDate: '2026-07-30',
  sponsors: [{ bioguideId: 'X000001' }],
  policyArea: { name: 'Health' },
};

const DOC_BODY = '<html><body>SEC. 1. THE ENGROSSED OPERATIVE TEXT OF THE BILL.</body></html>';

const TAGGED = [
  '[HEADLINE_EN]', 'Budget blueprint sets 2027 spending targets for federal agencies',
  '[HEADLINE_ES]', 'El plan fija objetivos de gasto para 2027',
  '[TLDR]', 'It sets spending targets.',
  '[WHAT]', 'It sets spending targets.',
  '[WHO]', 'Federal agencies.',
  '[WHY]', 'It shapes later spending bills.',
  '[COST]', 'NONE',
  '[COST_CHIPS]', 'NONE',
  '[ES_TLDR]', 'Fija objetivos de gasto.',
  '[ES_WHAT]', 'Fija objetivos de gasto.',
  '[ES_WHO]', 'Agencias federales.',
  '[ES_WHY]', 'Influye en leyes de gasto posteriores.',
  '[ES_COST]', 'NONE',
  '[ES_COST_CHIPS]', 'NONE',
  '[ES_SUMMARY]', 'Resumen completo en espanol.',
].join('\n');

const SEARCH_REPLY = '[PRESS_NAMES]\nNONE\n[NEWS_QUERY]\nSenate "budget resolution"';

/** An Anthropic client that records every call. The decode-refusal tests
 *  assert this is never touched — a refused bill must not cost a token. */
function anthropicSpy() {
  const prompts: string[] = [];
  const client = {
    messages: {
      create: async (params: { model: string; messages: { content: string }[] }) => {
        const prompt = params.messages[0].content;
        prompts.push(prompt);
        const text = params.model.includes('haiku')
          ? SEARCH_REPLY
          : prompt.startsWith('Explain this congressional bill')
            ? 'This resolution sets spending targets for fiscal year 2027.'
            : TAGGED;
        return { content: [{ text }] };
      },
    },
  };
  return { prompts, client };
}

/** Serve Congress.gov's two endpoints plus the text document, from memory. */
function stubFetch(opts: { versions?: unknown[]; docStatus?: number }) {
  const fetched: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes('/text?')) {
      return { ok: true, status: 200, json: async () => ({ textVersions: opts.versions ?? [] }) };
    }
    if (url.includes('api.congress.gov')) {
      return { ok: true, status: 200, json: async () => ({ bill: DETAIL }) };
    }
    const status = opts.docStatus ?? 200;
    return { ok: status === 200, status, text: async () => DOC_BODY };
  }) as unknown as typeof fetch;
  return fetched;
}

function corpus() {
  return { bills: [] as unknown[], es: {} as Record<string, unknown>, bySlug: new Map(), forceSlugs: new Set<string>(), allowDecode: true };
}

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test.describe('a bill with no published text is never decoded', () => {
  test('null text: no record created, the skip is signaled, and the model is never called', async () => {
    const { prompts, client } = anthropicSpy();
    stubFetch({ versions: [] }); // sconres-38/39: zero textVersions, live-verified
    const ctx = { ...corpus(), anthropic: client };

    const result = await syncOneBill({ type: 'sconres', number: '38' }, ctx);

    expect(result.outcome).toBe('skipped_no_text');
    // Nothing stored, in either language, in either index.
    expect(ctx.bills).toHaveLength(0);
    expect(Object.keys(ctx.es)).toHaveLength(0);
    expect(ctx.bySlug.size).toBe(0);
    // And no decode was spent inventing what the bill "typically" contains.
    expect(prompts).toHaveLength(0);
  });

  test('a version that exists but cannot be fetched is a FAILURE, not a text-less bill', async () => {
    // The distinction is load-bearing for the cursor: 'skipped_no_text' lets
    // it advance (nothing to retry), 'failed' on a new bill freezes it so the
    // next run tries again. A 500 on the document is transient, not absence.
    const { prompts, client } = anthropicSpy();
    stubFetch({ versions: inProgressVersions(), docStatus: 500 });
    const ctx = { ...corpus(), anthropic: client };

    const result = await syncOneBill({ type: 's', number: '1199' }, ctx);

    expect(result.outcome).toBe('failed');
    expect(result.isNew).toBe(true);
    expect(ctx.bills).toHaveLength(0);
    expect(prompts).toHaveLength(0); // still no token spent on an unread document
  });
});

test.describe('a bill with text decodes exactly as before, from the newest version', () => {
  test('the document fetched is the current version, and its words are what the model is given', async () => {
    const { prompts, client } = anthropicSpy();
    const fetched = stubFetch({ versions: inProgressVersions() });
    const ctx = { ...corpus(), anthropic: client };

    const result = await syncOneBill({ type: 's', number: '1199' }, ctx);

    expect(result.outcome).toBe('added');
    // The engrossed text — NOT s1199is.htm, which is what shipped for a year.
    expect(fetched).toContain('https://congress.gov/s1199es.htm');
    expect(fetched).not.toContain('https://congress.gov/s1199is.htm');
    // The decode prompt carries the document, not a title standing in for it.
    expect(prompts[0]).toContain('THE ENGROSSED OPERATIVE TEXT OF THE BILL');

    const bill = ctx.bills[0] as Record<string, string>;
    expect(bill.full_identifier).toBe('s-1199-119');
    expect(bill.status).toBe('floor_vote');
    expect(bill.ai_summary).toBe('This resolution sets spending targets for fiscal year 2027.');
    expect(bill.ai_headline).toContain('Budget blueprint');
    expect(ctx.es['s-1199-119']).toBeTruthy(); // ES parity, unchanged
    expect(ctx.bySlug.size).toBe(1);
  });
});
