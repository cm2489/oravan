import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { redecodeBill } from '../scripts/bill-decode.mjs';
import {
  DECODE_LOCKS_PATH,
  decodeLockLine,
  decodeLockVerdict,
  parseDecodeLocks,
  readDecodeLocks,
} from '../scripts/decode-locks.mjs';
import { alarms, parseDecodeLockStale } from '../lib/pipeline-health.mjs';

/*
 * PINS the decode locks (scripts/decode-locks.mjs): a decode a person
 * corrected by hand is never rewritten by a re-decode.
 *
 * THE FAILURE IT EXISTS FOR: #562 (2026-11-24) corrected one wrong sentence in
 * each of hr-9237-119's and hr-2347-119's decodes, in both languages. The
 * next re-decode of either bill (the nightly's new-text trigger, a
 * FORCE_REDECODE_SLUGS run, or either newsdesk trigger) would have written a
 * fresh model decode over the correction with nobody told.
 *
 * No network and no model: Congress.gov is stubbed, and the model client
 * counts its calls (and in the locked cases throws if it is called at all).
 */

process.env.CONGRESS_API_KEY ??= 'test-key-never-sent-anywhere';

const fmt = (url: string) => [{ type: 'PDF', url: url + '.pdf' }, { type: 'Formatted Text', url }];

type Version = { type: string; date: string | null; formats: { type: string; url: string }[] };

/** Congress.gov's /text endpoint plus the document behind it. */
function stubCongress(versions: Version[], body = 'SEC. 1. SHORT TITLE. This Act may be cited as the Test Act.') {
  const original = globalThis.fetch;
  let textCalls = 0;
  let documentCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes('api.congress.gov')) {
      textCalls++;
      return new Response(JSON.stringify({ textVersions: versions }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    documentCalls++;
    return new Response(`<html><body>${body}</body></html>`, { status: 200 });
  }) as typeof fetch;
  return {
    restore: () => { globalThis.fetch = original; },
    calls: () => ({ textCalls, documentCalls }),
  };
}

/** hr-2347-119's five versions as the lock records them: the current one is
 *  the Senate's engrossed amendment of 2026-11-19. */
function lockedVersions(): Version[] {
  return [
    { type: 'Engrossed Amendment Senate', date: '2026-11-19T05:00:00Z', formats: fmt('https://congress.gov/hr2347eas.htm') },
    { type: 'Engrossed in House', date: '2026-07-01T04:00:00Z', formats: fmt('https://congress.gov/hr2347eh.htm') },
    { type: 'Reported in House', date: '2026-05-01T04:00:00Z', formats: fmt('https://congress.gov/hr2347rh.htm') },
    { type: 'Introduced in House', date: '2025-03-25T04:00:00Z', formats: fmt('https://congress.gov/hr2347ih.htm') },
    { type: 'Placed on Calendar Senate', date: '2025-03-20T04:00:00Z', formats: fmt('https://congress.gov/hr2347pcs.htm') },
  ];
}

/** Six versions: the House concurred and the bill was enrolled after the lock. */
function newerVersions(): Version[] {
  return [
    { type: 'Enrolled Bill', date: '2026-12-02T05:00:00Z', formats: fmt('https://congress.gov/hr2347enr.htm') },
    ...lockedVersions(),
  ];
}

const LOCK = {
  reason: 'Hand-corrected in a test.',
  locked_on: '2026-11-25',
  pr: 562,
  text_version_date: '2026-11-19T05:00:00Z',
  text_version_type: 'Engrossed Amendment Senate',
  text_version_count: 5,
};

function corpusBill(overrides: Record<string, unknown> = {}) {
  return {
    full_identifier: 'hr-2347-119',
    congress_number: 119,
    bill_type: 'hr',
    bill_number: 2347,
    title: 'A test act.',
    ai_summary: 'The corrected summary a person wrote.',
    ai_headline: 'Corrected headline',
    ai_sections: { tldr: 'corrected', what: 'w', who: 'o', why: 'y', cost: null, costChips: null },
    decoded_at: '2026-11-21T09:42:01.617Z',
    decode_text_sha: '1d7c60fc8e7aacfa',
    decode_text_verified_at: '2026-11-21T09:42:01.617Z',
    text_version_date: '2026-11-19T05:00:00Z',
    text_version_type: 'Engrossed Amendment Senate',
    text_version_count: 5,
    ...overrides,
  } as Record<string, unknown>;
}

const ES_ENTRY = { headline: 'Titular corregido', summary: 'El resumen corregido.', sections: { tldr: 'corregido' } };

/** A model that must never be reached. */
const noModel = {
  messages: { create: async () => { throw new Error('a model call was made for a locked bill'); } },
};

/** A model that returns a valid two-call decode, counting its calls. */
function countingModel() {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      messages: {
        create: async () => {
          calls++;
          return {
            content: [{
              type: 'text',
              text: calls === 1 ? 'A fresh machine summary.' : [
                '[HEADLINE_EN]\nH', '[HEADLINE_ES]\nH', '[TLDR]\nT', '[WHAT]\nW', '[WHO]\nO',
                '[WHY]\nY', '[COST]\nNONE', '[COST_CHIPS]\nNONE', '[ES_TLDR]\nT', '[ES_WHAT]\nW',
                '[ES_WHO]\nO', '[ES_WHY]\nY', '[ES_COST]\nNONE', '[ES_COST_CHIPS]\nNONE',
                '[ES_SUMMARY]\nR',
              ].join('\n'),
            }],
          };
        },
      },
    },
  };
}

/** Capture console.log/console.error lines for the duration of `fn`. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = log;
    console.error = err;
  }
}

// ---------------------------------------------------------------------------
// 1. redecodeBill — the one writer behind every pipeline re-decode
// ---------------------------------------------------------------------------

test.describe('redecodeBill refuses a locked bill', () => {
  test('locked + same text version: no model call, no write, one log line', async () => {
    const stub = stubCongress(lockedVersions());
    try {
      const bill = corpusBill();
      const before = structuredClone(bill);
      const es: Record<string, unknown> = { 'hr-2347-119': structuredClone(ES_ENTRY) };
      const { result, lines } = await captureLogs(() =>
        redecodeBill('hr-2347-119', {
          anthropic: noModel, es, bySlug: new Map([['hr-2347-119', bill]]),
          locks: new Map([['hr-2347-119', LOCK]]),
        })
      );
      expect(result.outcome).toBe('locked');
      expect(result.decodeAttempted).toBe(false);
      expect(result.lockStale).toBe(false);
      // Byte-identical: not even the provenance stamps a 'text-unchanged'
      // veto would write.
      expect(bill).toEqual(before);
      expect(es['hr-2347-119']).toEqual(ES_ENTRY);
      // Only the free /text list was read; the document was not fetched.
      expect(stub.calls()).toEqual({ textCalls: 1, documentCalls: 0 });
      const said = lines.filter((l) => l.includes('hr-2347-119'));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('decode locked by PR #562');
      expect(said[0]).not.toContain('DECODE LOCK STALE');
    } finally {
      stub.restore();
    }
  });

  test('a FORCED slug does not outrank a lock', async () => {
    const stub = stubCongress(lockedVersions());
    try {
      const bill = corpusBill();
      const before = structuredClone(bill);
      const { result } = await captureLogs(() =>
        redecodeBill('hr-2347-119', {
          anthropic: noModel, es: {}, bySlug: new Map([['hr-2347-119', bill]]),
          forced: true, locks: new Map([['hr-2347-119', LOCK]]),
        })
      );
      expect(result.outcome).toBe('locked');
      expect(bill).toEqual(before);
    } finally {
      stub.restore();
    }
  });

  test('unlocked: the ordinary re-decode still runs and writes', async () => {
    // The same bill and the same newer text, with no lock: the gate must not
    // have broken the path every other bill takes.
    const stub = stubCongress(newerVersions());
    try {
      const bill = corpusBill();
      const es: Record<string, unknown> = { 'hr-2347-119': structuredClone(ES_ENTRY) };
      const model = countingModel();
      const { result } = await captureLogs(() =>
        redecodeBill('hr-2347-119', {
          anthropic: model.client, es, bySlug: new Map([['hr-2347-119', bill]]),
          locks: new Map(),
        })
      );
      expect(result.outcome).toBe('redecoded');
      expect(model.calls()).toBe(2);
      expect(bill.ai_summary).toBe('A fresh machine summary.');
      expect(bill.text_version_type).toBe('Enrolled Bill');
      expect(bill.text_version_count).toBe(6);
      expect(es['hr-2347-119']).not.toEqual(ES_ENTRY);
    } finally {
      stub.restore();
    }
  });

  test('locked + NEW text version: still skipped, and the stale alarm line is printed', async () => {
    const stub = stubCongress(newerVersions());
    try {
      const bill = corpusBill();
      const before = structuredClone(bill);
      const es: Record<string, unknown> = { 'hr-2347-119': structuredClone(ES_ENTRY) };
      const { result, lines } = await captureLogs(() =>
        redecodeBill('hr-2347-119', {
          anthropic: noModel, es, bySlug: new Map([['hr-2347-119', bill]]),
          locks: new Map([['hr-2347-119', LOCK]]),
        })
      );
      expect(result.outcome).toBe('locked');
      expect(result.decodeAttempted).toBe(false);
      expect(result.lockStale).toBe(true);
      expect(bill).toEqual(before);
      expect(es['hr-2347-119']).toEqual(ES_ENTRY);
      const stale = lines.filter((l) => l.startsWith('::warning::DECODE LOCK STALE: hr-2347-119 '));
      expect(stale).toHaveLength(1);
      // ...and the health report reads that exact line back as its alarm.
      const parsed = parseDecodeLockStale(stale.join('\n'));
      expect(parsed.map((p) => p.slug)).toEqual(['hr-2347-119']);
    } finally {
      stub.restore();
    }
  });

  test('a vehicle swap (new title) on a locked bill is a stale lock, not a re-decode', async () => {
    const stub = stubCongress(lockedVersions());
    try {
      const bill = corpusBill();
      const before = structuredClone(bill);
      const { result } = await captureLogs(() =>
        redecodeBill('hr-2347-119', {
          anthropic: noModel, es: {}, bySlug: new Map([['hr-2347-119', bill]]),
          title: 'A different act under the same number.',
          locks: new Map([['hr-2347-119', LOCK]]),
        })
      );
      expect(result.outcome).toBe('locked');
      expect(result.lockStale).toBe(true);
      // The served title is written only beside a new decode; there is none.
      expect(bill).toEqual(before);
    } finally {
      stub.restore();
    }
  });

  test('the version check failing still holds the lock (free, nothing written)', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const realTimeout = globalThis.setTimeout;
    // cg() backs off 2s, 4s, ... between retries; run them at once.
    globalThis.setTimeout = ((fn: () => void) => realTimeout(fn, 0)) as typeof setTimeout;
    try {
      const bill = corpusBill();
      const before = structuredClone(bill);
      const { result } = await captureLogs(() =>
        redecodeBill('hr-2347-119', {
          anthropic: noModel, es: {}, bySlug: new Map([['hr-2347-119', bill]]),
          locks: new Map([['hr-2347-119', LOCK]]),
        })
      );
      expect(result.outcome).toBe('locked');
      expect(result.lockStale).toBe(false);
      expect(bill).toEqual(before);
    } finally {
      globalThis.fetch = original;
      globalThis.setTimeout = realTimeout;
    }
  });

  test('an unreadable lock file fails CLOSED: no re-decode, nothing charged', async () => {
    const stub = stubCongress(newerVersions());
    try {
      const bill = corpusBill();
      const before = structuredClone(bill);
      const broken = { get: () => { throw new Error('decode-locks: the file is not a JSON object'); } };
      const { result } = await captureLogs(() =>
        redecodeBill('hr-2347-119', {
          anthropic: noModel, es: {}, bySlug: new Map([['hr-2347-119', bill]]),
          locks: broken,
        })
      );
      expect(result.outcome).toBe('failed');
      expect(result.decodeAttempted).toBe(false);
      expect(bill).toEqual(before);
    } finally {
      stub.restore();
    }
  });

  test('with no `locks` passed, the COMMITTED file protects the two #562 bills', async () => {
    // The real wiring: callers pass no locks, so data/decode-locks.json is read.
    const stub = stubCongress(lockedVersions());
    try {
      for (const slug of ['hr-2347-119', 'hr-9237-119']) {
        const bill = corpusBill({ full_identifier: slug, bill_number: Number(slug.split('-')[1]) });
        const before = structuredClone(bill);
        const { result } = await captureLogs(() =>
          redecodeBill(slug, { anthropic: noModel, es: {}, bySlug: new Map([[slug, bill]]) })
        );
        expect(result.outcome, slug).toBe('locked');
        expect(bill, slug).toEqual(before);
      }
    } finally {
      stub.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. decodeLockVerdict — when a person must be told
// ---------------------------------------------------------------------------

test.describe('decodeLockVerdict', () => {
  test('the same version is not stale', () => {
    const v = decodeLockVerdict(LOCK, { versions: lockedVersions(), count: 5 });
    expect(v).toMatchObject({ stale: false, reason: 'same-text' });
  });

  test('a newer date, another type, a higher count or a new title each make it stale', () => {
    const newerDate = [{ ...lockedVersions()[0], date: '2026-12-01T05:00:00Z' }, ...lockedVersions().slice(1)];
    expect(decodeLockVerdict(LOCK, { versions: newerDate, count: 5 })).toMatchObject({ stale: true, reason: 'newer-date' });
    // An enrolled bill often carries NO date; the type and the count still see it.
    const undatedEnrolled = [{ type: 'Enrolled Bill', date: null, formats: fmt('https://congress.gov/enr.htm') }, ...lockedVersions()];
    const v = decodeLockVerdict(LOCK, { versions: undatedEnrolled, count: 6 });
    expect(v.stale).toBe(true);
    expect(v.reason).toBe('other-type');
    expect(v.detail).toContain('6 text versions published, 5 when locked');
    expect(decodeLockVerdict(LOCK, { versions: lockedVersions(), count: 6 })).toMatchObject({ stale: true, reason: 'more-versions' });
    expect(decodeLockVerdict(LOCK, { versions: lockedVersions(), count: 5, newTitle: 'Another act' })).toMatchObject({ stale: true, reason: 'new-title' });
  });

  test('a lock that recorded only a count (hr-9237-119) goes stale on a second version', () => {
    const countOnly = { ...LOCK, text_version_date: null, text_version_type: null, text_version_count: 1 };
    const one = [lockedVersions()[3]];
    expect(decodeLockVerdict(countOnly, { versions: one, count: 1 }).stale).toBe(false);
    expect(decodeLockVerdict(countOnly, { versions: lockedVersions().slice(2, 4), count: 2 }).stale).toBe(true);
  });

  test('an unreadable version list is "unknown", never stale and never a release', () => {
    expect(decodeLockVerdict(LOCK, { versions: null, count: null })).toMatchObject({ stale: false, reason: 'unknown' });
  });

  test('only the stale line carries the tag the health parser reads', () => {
    const fresh = decodeLockLine('hr-2347-119', LOCK, { stale: false, reason: 'same-text', detail: 'x' });
    const stale = decodeLockLine('hr-2347-119', LOCK, { stale: true, reason: 'more-versions', detail: 'y' });
    expect(parseDecodeLockStale(fresh)).toEqual([]);
    expect(parseDecodeLockStale(stale).map((p) => p.slug)).toEqual(['hr-2347-119']);
  });
});

// ---------------------------------------------------------------------------
// 3. The committed file
// ---------------------------------------------------------------------------

test.describe('data/decode-locks.json', () => {
  test('parses, and every lock names a bill that is in the corpus', () => {
    const locks = readDecodeLocks(DECODE_LOCKS_PATH);
    const bills = JSON.parse(readFileSync('data/bills.json', 'utf8')) as { full_identifier: string }[];
    const ids = new Set(bills.map((b) => b.full_identifier));
    // A lock on a bill not in the corpus would protect nothing (completeDecode,
    // the new-bill writer, never meets an existing bill) and would read as
    // protection that is not there.
    for (const slug of locks.keys()) expect(ids.has(slug), slug).toBe(true);
  });

  test('the two #562 corrections are locked', () => {
    const locks = readDecodeLocks(DECODE_LOCKS_PATH);
    for (const slug of ['hr-9237-119', 'hr-2347-119']) {
      expect(locks.get(slug)?.pr, slug).toBe(562);
    }
  });

  test('a malformed lock is refused loudly, naming it', () => {
    const ok = { locks: { 'hr-1-119': { ...LOCK } } };
    expect(parseDecodeLocks(ok).size).toBe(1);
    expect(() => parseDecodeLocks({})).toThrow(/"locks" must be an object/);
    expect(() => parseDecodeLocks({ locks: { 'HR 1': { ...LOCK } } })).toThrow(/HR 1/);
    expect(() => parseDecodeLocks({ locks: { 'hr-1-119': { ...LOCK, pr: 'x' } } })).toThrow(/pr must be/);
    expect(() => parseDecodeLocks({ locks: { 'hr-1-119': { ...LOCK, locked_on: 'Nov 25' } } })).toThrow(/locked_on/);
    const noCount: Record<string, unknown> = { ...LOCK };
    delete noCount.text_version_count;
    expect(() => parseDecodeLocks({ locks: { 'hr-1-119': noCount } })).toThrow(/text_version_count is missing/);
    expect(() =>
      parseDecodeLocks({ locks: { 'hr-1-119': { ...LOCK, text_version_date: null, text_version_type: null, text_version_count: null } } })
    ).toThrow(/no text version at all/);
  });
});

// ---------------------------------------------------------------------------
// 4. The alarm and the other writers
// ---------------------------------------------------------------------------

test.describe('the stale-lock alarm reaches the pipeline-health report', () => {
  test('parseDecodeLockStale reads GitHub log lines, one entry per bill', () => {
    const log = [
      'sync\tre-decode\t2026-12-03T05:10:00.0000000Z ##[warning]DECODE LOCK STALE: hr-2347-119 has newer text than its hand-corrected decode (PR #562, locked 2026-11-25): 6 text versions published, 5 when locked. Kept the corrected decode.',
      'sync\tre-decode\t2026-12-03T05:10:01.0000000Z   hr-9237-119: re-decode skipped - decode locked by PR #562 (2026-11-25); same text',
      'sync\tre-decode\t2026-12-03T05:11:00.0000000Z ::warning::DECODE LOCK STALE: hr-2347-119 has newer text (again)',
    ].join('\n');
    const parsed = parseDecodeLockStale([log, log]);
    expect(parsed.map((p) => p.slug)).toEqual(['hr-2347-119']);
  });

  test('alarms() raises decode-lock-stale and stays quiet without one', () => {
    const base = { nightly: { conclusion: 'success' } };
    expect(alarms(base).some((a: { code: string }) => a.code === 'decode-lock-stale')).toBe(false);
    const raised = alarms({ ...base, decodeLockStale: [{ slug: 'hr-2347-119', text: 'hr-2347-119 has newer text' }] });
    const a = raised.find((x: { code: string }) => x.code === 'decode-lock-stale');
    expect(a?.text).toContain('hr-2347-119');
    expect(a?.text).toContain('data/decode-locks.json');
  });

  test('scripts/pipeline-health.mjs reads the stale lines from every data-workflow log', () => {
    const src = readFileSync('scripts/pipeline-health.mjs', 'utf8');
    expect(src).toContain('parseDecodeLockStale(log)');
    expect(src).toMatch(/\n\s+decodeLockStale,\n/);
  });

  test('the nightly drops locked bills BEFORE the re-decode ceiling is applied', () => {
    const src = readFileSync('scripts/sync-bills.mjs', 'utf8');
    const lockCheck = src.indexOf('locks.get(c.slug)');
    const plan = src.indexOf('const redecodePlan = planRedecodes(');
    expect(lockCheck).toBeGreaterThan(0);
    expect(lockCheck).toBeLessThan(plan);
    // ...and a 'locked' result is counted as held, never as a failure.
    expect(src).toContain("result.outcome === 'locked'");
  });

  test('every one-off script that rewrites decode fields skips locked bills', () => {
    for (const f of ['merge-headlines', 'restructure-decoded', 'generate-cost-chips', 'translate-summaries']) {
      const src = readFileSync(`scripts/${f}.mjs`, 'utf8');
      expect(src, f).toContain("import { decodeLocks } from './decode-locks.mjs';");
      expect(src, f).toMatch(/locks\.has\(/);
    }
  });
});
