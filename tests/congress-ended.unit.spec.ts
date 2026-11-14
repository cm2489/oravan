import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  CONGRESS,
  CONGRESS_POLICY,
  ENDED_CONGRESSES,
  congressOfBill,
  congressTerm,
  endedCongress,
  isEndedBill,
  isEndedCongress,
  isKnownCongress,
  isTrackedCongress,
} from '../lib/congress.mjs';
import {
  ENDED_FROZEN_FIELDS,
  billApiPath,
  cg,
  corpusCongressVerdict,
  endedBillProblems,
  fetchBillActions,
  hotBillTarget,
  offCongressBills,
  refreshBillFields,
} from '../scripts/congress-fetch.mjs';
import { fetchTextVersions, redecodeBill, syncOneBill } from '../scripts/bill-decode.mjs';
import { splitEndedVehicles, vehicleActionsPath } from '../scripts/moment-updates-map.mjs';
import { planSummaries } from '../scripts/moment-updates.mjs';
import { cursorIsAhead } from '../lib/votes-core.mjs';
import { planCombos } from '../lib/pregen';
import type { Bill } from '../lib/types';

/*
 * ENDED CONGRESSES IN THE PIPELINE (2026-11-12, stage 2 of the new-Congress
 * work). The owner decided on Nov 12, 2026 to keep the 119th Congress's bills
 * as an archive marked "ended" and to read the 120th alongside them.
 *
 * Two halves:
 *   1. TODAY the ended list is empty, and every helper answers what the
 *      pipeline already assumed (one Congress, nothing ended). The verify-sync
 *      verdict is the old gate word for word.
 *   2. WITH THE LIST FILLED in a test (119 ended, 120 tracked) — passed as a
 *      `policy` argument, never by editing lib/congress.mjs — the new rules
 *      hold: verify-sync accepts a mixed corpus and freezes the ended half;
 *      every fetch reads the bill's own Congress; nothing spends on an ended
 *      bill; the vote marker orders across Congresses; and H.R. 1234 of each
 *      Congress lives beside the other without either record touching it.
 *
 * Fixtures only. Nothing here reads data/.
 */

const SWITCHED = Object.freeze({
  tracked: 120,
  ended: Object.freeze([Object.freeze({ number: 119, ended: '2027-01-03' })]),
});

type Rec = Record<string, unknown>;

/** A corpus record of `congress` (H.R. 1234 by default). */
function rec(congress: number, overrides: Rec = {}): Rec {
  const number = (overrides.bill_number as number | undefined) ?? 1234;
  const type = (overrides.bill_type as string | undefined) ?? 'hr';
  return {
    full_identifier: `${type}-${number}-${congress}`,
    congress_number: congress,
    bill_type: type,
    bill_number: number,
    title: `An act of the ${congress}th Congress.`,
    short_title: null,
    ai_summary: `Summary of the ${congress}th Congress's bill.`,
    ai_headline: `Headline ${congress}`,
    ai_sections: { tldr: 't', what: 'w', who: 'o', why: 'y', cost: null, costChips: null },
    sponsor_bioguide_id: 'A000001',
    introduced_date: congress === 119 ? '2025-02-01' : '2027-01-10',
    last_action_date: congress === 119 ? '2026-12-01' : '2027-01-15',
    last_action_text: 'Referred to the Committee on Ways and Means.',
    status: 'committee',
    issue_tags: ['health'],
    policy_area: 'Health',
    urgency_score: 0.2,
    congress_gov_url: `https://www.congress.gov/bill/${congress}th-congress/house-bill/${number}`,
    press_names: ['Act'],
    news_query: '"Act"',
    ...overrides,
  };
}

const slug = (b: Rec) => String(b.full_identifier);

/** Record every Congress.gov request; answer with `reply(pathname)`. */
function stubCongressGov(reply: (path: string) => unknown) {
  const original = globalThis.fetch;
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'CONGRESS_API_KEY');
  const oldKey = process.env.CONGRESS_API_KEY;
  // A dummy value so cg() runs; it never leaves this process (fetch is stubbed).
  process.env.CONGRESS_API_KEY = 'unit-test-not-a-key';
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname !== 'api.congress.gov') throw new Error(`unexpected request to ${url.hostname}`);
    const path = url.pathname.replace(/^\/v3/, '');
    paths.push(path);
    return new Response(JSON.stringify(reply(path)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const restore = () => {
    globalThis.fetch = original;
    if (hadKey) process.env.CONGRESS_API_KEY = oldKey;
    else delete process.env.CONGRESS_API_KEY;
  };
  return { paths, restore };
}

// --------------------------------------------------------------------------
// 1. Today: the list is empty and nothing changes
// --------------------------------------------------------------------------

test.describe('today: the ended list is empty', () => {
  test('ENDED_CONGRESSES is empty and frozen; the policy tracks CONGRESS', () => {
    // The switch (stage 8) fills it, deliberately, in the same change that
    // moves CONGRESS. Until then this must stay empty.
    //
    // Filling it also trips the January guard in
    // tests/short-address.unit.spec.ts (#404): what a short address such as
    // oravan.org/hr1 opens once bill numbers restart is the owner's decision,
    // and that test, unlike this one, is not the switch's to rewrite. Its
    // message lists his three choices; his dated ruling goes in
    // SHORT_ADDRESS_ROLLOVER_RULING (lib/short-address.ts).
    expect(ENDED_CONGRESSES).toEqual([]);
    expect(Object.isFrozen(ENDED_CONGRESSES)).toBe(true);
    expect(Object.isFrozen(CONGRESS_POLICY)).toBe(true);
    expect(CONGRESS_POLICY.tracked).toBe(CONGRESS);
    expect(CONGRESS_POLICY.ended).toBe(ENDED_CONGRESSES);
  });

  test('every entry, once there is one, is an earlier Congress ended on its own term date', () => {
    const numbers = new Set<number>();
    for (const e of ENDED_CONGRESSES) {
      expect(Number.isInteger(e.number) && e.number < CONGRESS).toBe(true);
      expect(e.ended).toBe(congressTerm(e.number).end);
      expect(numbers.has(e.number)).toBe(false);
      numbers.add(e.number);
    }
  });

  test('no Congress is ended, and only the tracked one is known', () => {
    for (const n of [117, 118, 119, 120, 121]) {
      expect(isEndedCongress(n)).toBe(false);
      expect(endedCongress(n)).toBeNull();
      expect(isTrackedCongress(n)).toBe(n === CONGRESS);
      expect(isKnownCongress(n)).toBe(n === CONGRESS);
    }
    expect(isEndedBill(rec(119))).toBe(false);
    expect(isEndedBill('hr-1234-119')).toBe(false);
  });

  test('the verify-sync verdict is the old corpus-uniformity gate, word for word', () => {
    const clean = [rec(119), rec(119, { bill_number: 5 })];
    expect(corpusCongressVerdict({ bills: clean })).toEqual({
      failures: [],
      notes: [`corpus uniformity: all 2 bills are ${CONGRESS}th Congress`],
    });
    // The message the gate printed before 2026-11-12, rebuilt from its old
    // template with offCongressBills, the function it called.
    const dirty = [...clean, rec(118, { bill_number: 1776, bill_type: 's' }), { ...rec(119, { bill_number: 7 }), congress_number: '119' }];
    const strays = offCongressBills(dirty, CONGRESS);
    expect(strays).toEqual(['s-1776-118', 'hr-7-119']);
    const old = `${strays.length} bills.json record(s) are not from the ${CONGRESS}th Congress (${strays.slice(0, 10).join(', ')}${strays.length > 10 ? ', …' : ''}) — every write path is pinned to CONGRESS=${CONGRESS} (scripts/congress-fetch.mjs), so these were seeded or force-fetched, and their pages assert present-tense activity for a Congress this build does not track. Remove them, or bump CONGRESS if the tracked Congress really changed.`;
    expect(corpusCongressVerdict({ bills: dirty })).toEqual({ failures: [old], notes: [] });
    // With the list empty, HEAD is not needed and the freeze has nothing to say.
    expect(endedBillProblems({ bills: dirty, before: null })).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// 2. With the list filled: 119 ended, 120 tracked
// --------------------------------------------------------------------------

test.describe('the helpers, with 119 ended and 120 tracked', () => {
  test('tell the tracked, the ended and the unknown apart', () => {
    expect(isTrackedCongress(120, SWITCHED)).toBe(true);
    expect(isEndedCongress(119, SWITCHED)).toBe(true);
    expect(endedCongress(119, SWITCHED)).toEqual({ number: 119, ended: '2027-01-03' });
    expect(isKnownCongress(118, SWITCHED)).toBe(false);
    expect(isEndedCongress('119', SWITCHED)).toBe(false); // strict: a string is not a Congress
  });

  test("read a bill's Congress from its record, else its slug, and never guess", () => {
    expect(congressOfBill(rec(119))).toBe(119);
    expect(congressOfBill({ full_identifier: 'hr-5634-119', bill_type: 'hr', bill_number: 5634 })).toBe(119);
    expect(congressOfBill('sjres-12-120')).toBe(120);
    expect(congressOfBill({ bill_type: 'hr', bill_number: 1 })).toBeNull();
    expect(isEndedBill(rec(119), SWITCHED)).toBe(true);
    expect(isEndedBill(rec(120), SWITCHED)).toBe(false);
    expect(isEndedBill('hr-1234-119', SWITCHED)).toBe(true);
  });
});

test.describe('verify-sync, with 119 ended and 120 tracked', () => {
  const before = [rec(119), rec(119, { bill_number: 5 }), rec(120)];
  const esBefore = { 'hr-1234-119': { headline: 'h119', summary: 's119' }, 'hr-1234-120': { headline: 'h120', summary: 's120' } };
  const verdict = (bills: Rec[], es: Rec = esBefore, beforeArg: Rec[] | null = before) =>
    corpusCongressVerdict({ bills, before: beforeArg, es, esBefore, policy: SWITCHED });

  test('accepts a mixed corpus whose ended half is unchanged', () => {
    const now = structuredClone(before);
    // The tracked Congress's H.R. 1234 moves on; the ended one's twin is untouched.
    Object.assign(now[2], { status: 'floor_vote', last_action_text: 'Passed House.', ai_summary: 'Re-decoded.' });
    const v = verdict([...now, rec(120, { bill_number: 9 })], { ...esBefore, 'hr-1234-120': { headline: 'new', summary: 'new' } });
    expect(v.failures).toEqual([]);
    expect(v.notes).toEqual(['corpus uniformity: 2 bill(s) of the tracked 120th Congress, 2 of ended Congress(es) 119th, all unchanged']);
  });

  test('lets the record move after the end (status and last action are not frozen)', () => {
    const now = structuredClone(before);
    Object.assign(now[0], { status: 'law', last_action_text: 'Became Public Law No: 119-300.', last_action_date: '2027-01-10', urgency_score: 0.1 });
    expect(verdict(now).failures).toEqual([]);
  });

  test('rejects an ADDED ended bill', () => {
    const v = verdict([...structuredClone(before), rec(119, { bill_number: 77 })]);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0]).toContain('hr-77-119: added, but its Congress has ended');
  });

  test('rejects a REMOVED ended bill', () => {
    const v = verdict(structuredClone(before).filter((b) => slug(b) !== 'hr-5-119'));
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0]).toContain('hr-5-119: removed, but its Congress has ended');
  });

  test('rejects an ALTERED ended bill, field by frozen field', () => {
    for (const field of ENDED_FROZEN_FIELDS) {
      const now = structuredClone(before);
      (now[0] as Rec)[field] = field === 'ai_sections' ? { tldr: 'changed' } : `changed ${field}`;
      if (field === 'congress_number' || field === 'full_identifier' || field === 'bill_type' || field === 'bill_number') {
        // An identity change makes it a different bill: the original is gone
        // (and the changed one is either added or not of a known Congress).
        expect(verdict(now).failures.length).toBeGreaterThan(0);
        continue;
      }
      const v = verdict(now);
      expect(v.failures, field).toHaveLength(1);
      expect(v.failures[0], field).toContain(`hr-1234-119: ${field} changed, but its Congress has ended`);
    }
  });

  test("rejects a changed or dropped Spanish twin of an ended bill", () => {
    const changed = verdict(structuredClone(before), { ...esBefore, 'hr-1234-119': { headline: 'x', summary: 'y' } });
    expect(changed.failures[0]).toContain('hr-1234-119: its Spanish twin (bills-es.json) changed');
    const rest: Rec = { ...esBefore };
    delete rest['hr-1234-119'];
    expect(verdict(structuredClone(before), rest).failures[0]).toContain('hr-1234-119: its Spanish twin');
  });

  test('fails closed when the committed corpus cannot be read', () => {
    const v = verdict(structuredClone(before), esBefore, null);
    expect(v.failures[0]).toContain('could not be read');
  });

  test('still rejects a bill of a Congress that is neither tracked nor ended', () => {
    const v = verdict([...structuredClone(before), rec(118, { bill_type: 's', bill_number: 1776 })]);
    expect(v.failures[0]).toContain('from neither the tracked 120th Congress nor an ended one (119th) (s-1776-118)');
    expect(v.notes).toEqual([]);
  });
});

test.describe("every fetch for an existing bill reads the bill's own Congress", () => {
  test('billApiPath: H.R. 1234 of each Congress gets its own address, and no Congress is refused', () => {
    expect(billApiPath(rec(119))).toBe('/bill/119/hr/1234');
    expect(billApiPath(rec(120), '/actions')).toBe('/bill/120/hr/1234/actions');
    expect(billApiPath({ full_identifier: 'sconres-12-119', bill_type: 'SConRes', bill_number: '12' }, '/text')).toBe('/bill/119/sconres/12/text');
    expect(() => billApiPath({ bill_type: 'hr', bill_number: 1234 })).toThrow(/refusing to guess/);
  });

  test('the actions fetch (ambiguous-status resolution, the closing sweep) uses the record', async () => {
    const { paths, restore } = stubCongressGov(() => ({ actions: [] }));
    try {
      await fetchBillActions(rec(119) as never);
      await fetchBillActions(rec(120) as never);
      // No Congress on the record: "could not look", and nothing is fetched.
      expect(await fetchBillActions({ bill_type: 'hr', bill_number: 1234 })).toBeNull();
    } finally {
      restore();
    }
    expect(paths).toEqual(['/bill/119/hr/1234/actions', '/bill/120/hr/1234/actions']);
  });

  test("the text fetch (decode, re-decode, the new-text probe) uses the bill's Congress", async () => {
    const { paths, restore } = stubCongressGov(() => ({ textVersions: [] }));
    try {
      await fetchTextVersions('hr', 1234, 119);
      await fetchTextVersions('hr', 1234, 120);
      await expect(fetchTextVersions('hr', 1234, undefined as unknown as number)).rejects.toThrow(/refusing to guess/);
    } finally {
      restore();
    }
    expect(paths).toEqual(['/bill/119/hr/1234/text', '/bill/120/hr/1234/text']);
  });

  test("a re-decode of a bill that is not the tracked Congress's reads its own text", async () => {
    // 119 NOT ended here (tracked 120, nothing ended): the read goes to 119.
    const policy = { tracked: 120, ended: [] };
    const bill = rec(119);
    const { paths, restore } = stubCongressGov(() => ({ textVersions: [] }));
    try {
      const r = await redecodeBill('hr-1234-119', { anthropic: null, es: {}, bySlug: new Map([['hr-1234-119', bill]]), policy });
      expect(r.outcome).toBe('skipped_no_text');
    } finally {
      restore();
    }
    expect(paths).toEqual(['/bill/119/hr/1234/text']);
  });

  test('the refresh keeps the record link in the bill\'s own Congress', async () => {
    const bill = rec(119, { congress_gov_url: 'stale' });
    const outcome = await refreshBillFields(bill, { latestAction: { text: 'Referred to the Committee on Finance.', actionDate: '2026-12-20' } });
    expect(outcome).toBe('refreshed');
    expect(bill.congress_gov_url).toBe('https://www.congress.gov/bill/119th-congress/house-bill/1234');
  });

  test('a record that names no Congress is left exactly as it was', async () => {
    const bill = { bill_type: 'hr', bill_number: 1234, status: 'committee', last_action_text: 'x' };
    const snapshot = structuredClone(bill);
    await expect(refreshBillFields(bill, { latestAction: { text: 'Passed House.' } })).rejects.toThrow(/refusing to guess/);
    expect(bill).toEqual(snapshot);
  });

  test("a Big Question vehicle's actions are read from the vehicle's own Congress", () => {
    expect(vehicleActionsPath('hr-1234-119')).toBe('/bill/119/hr/1234/actions');
    expect(vehicleActionsPath('hconres-89-120')).toBe('/bill/120/hconres/89/actions');
    expect(() => vehicleActionsPath('hr-1234')).toThrow(/refusing to guess/);
  });
});

test.describe('the same bill number in both Congresses: neither record touches the other', () => {
  test('the hot-bill refresh picks the tracked record, fetches its address, and leaves the ended twin alone', async () => {
    const old = rec(119);
    const cur = rec(120);
    const oldSnapshot = structuredClone(old);
    const bySlug = new Map([
      ['hr-1234-119', old],
      ['hr-1234-120', cur],
    ]);
    const target = hotBillTarget({ type: 'HR', number: '1234' }, bySlug, SWITCHED);
    expect(target).toEqual({ slug: 'hr-1234-120', existing: cur, skip: null });
    const { paths, restore } = stubCongressGov(() => ({
      bill: { latestAction: { text: 'Passed House.', actionDate: '2027-02-01' }, policyArea: { name: 'Health' } },
    }));
    try {
      const { bill: d } = await cg(billApiPath(target.existing as Rec));
      expect(await refreshBillFields(target.existing as Rec, d)).toBe('refreshed');
    } finally {
      restore();
    }
    expect(paths).toEqual(['/bill/120/hr/1234']);
    expect(cur.last_action_text).toBe('Passed House.');
    expect(cur.congress_gov_url).toBe('https://www.congress.gov/bill/120th-congress/house-bill/1234');
    expect(old).toEqual(oldSnapshot);
  });

  test('the hot-bill refresh never picks an ended record, even if the map points at one', () => {
    const bySlug = new Map([['hr-1234-120', rec(119)]]);
    expect(hotBillTarget({ type: 'hr', number: '1234' }, bySlug, SWITCHED).skip).toBe('ended');
    expect(hotBillTarget({ type: 'hr', number: '99' }, bySlug, SWITCHED).skip).toBe('new');
  });

  test('the nightly/newsdesk refresh path refreshes the tracked H.R. 1234 and refuses the ended one without a request', async () => {
    const old = rec(119);
    const cur = rec(120);
    const oldSnapshot = structuredClone(old);
    const bills = [old, cur];
    const bySlug = new Map(bills.map((b) => [slug(b), b]));
    const { paths, restore } = stubCongressGov(() => ({
      bill: { latestAction: { text: 'Referred to the Subcommittee on Health.', actionDate: '2027-02-02' }, title: cur.title, textVersions: { count: 1 } },
    }));
    try {
      const ctx = { allowDecode: false, bills, es: {}, bySlug, anthropic: null, policy: SWITCHED };
      // A bare {type, number}: a bill off the tracked list.
      expect((await syncOneBill({ type: 'hr', number: '1234' }, ctx)).outcome).toBe('refreshed');
      // The ended record, by its own Congress: refused, nothing fetched.
      const ended = await syncOneBill({ type: 'hr', number: '1234', congress_number: 119 }, ctx);
      expect(ended).toMatchObject({ outcome: 'skipped_ended', slug: 'hr-1234-119', decodeAttempted: false });
      // A Congress that is neither: refused, nothing fetched.
      expect((await syncOneBill({ type: 'hr', number: '1234', congress_number: 118 }, ctx)).outcome).toBe('skipped_untracked');
    } finally {
      restore();
    }
    expect(paths).toEqual(['/bill/120/hr/1234']);
    expect(cur.last_action_text).toBe('Referred to the Subcommittee on Health.');
    expect(old).toEqual(oldSnapshot);
  });
});

test.describe('nothing spends on an ended bill', () => {
  test('re-decoding: refused, even when forced, with no request and no model call', async () => {
    const bill = rec(119);
    const snapshot = structuredClone(bill);
    const { paths, restore } = stubCongressGov(() => ({ textVersions: [] }));
    try {
      for (const forced of [false, true]) {
        const r = await redecodeBill('hr-1234-119', {
          anthropic: { messages: { create: () => { throw new Error('model called'); } } },
          es: {},
          bySlug: new Map([['hr-1234-119', bill]]),
          forced,
          policy: SWITCHED,
        });
        expect(r).toEqual({ outcome: 'skipped_ended', slug: 'hr-1234-119', decodeAttempted: false });
      }
    } finally {
      restore();
    }
    expect(paths).toEqual([]);
    expect(bill).toEqual(snapshot);
  });

  test('call-script pregeneration: no combo for an ended bill', () => {
    const bills = [rec(119) as unknown as Bill, rec(120) as unknown as Bill];
    const today = planCombos(bills, ['support'], ['en']);
    expect(today.map((c) => c.slug)).toHaveLength(2);
    const switched = planCombos(bills, ['support', 'oppose'], ['en', 'es'], SWITCHED);
    expect(new Set(switched.map((c) => c.bill.congress_number))).toEqual(new Set([120]));
    expect(switched).toHaveLength(4);
  });

  test('Big Question updates: an ended vehicle is out of scope for collection', () => {
    const vehicles = [
      { momentId: 'a', slug: 'hr-1234-119' },
      { momentId: 'a', slug: 'hr-1234-120' },
      { momentId: 'b', slug: 's-5-119' },
    ];
    expect(splitEndedVehicles(vehicles)).toEqual({ live: vehicles, ended: [] });
    expect(splitEndedVehicles(vehicles, SWITCHED)).toEqual({
      live: [{ momentId: 'a', slug: 'hr-1234-120' }],
      ended: [
        { momentId: 'a', slug: 'hr-1234-119' },
        { momentId: 'b', slug: 's-5-119' },
      ],
    });
  });

  test('Big Question summaries: an ended vehicle grounds no summary and buys no model call', () => {
    const moments = {
      a: { status: 'live', vehicles: [{ slug: 'hr-1234-119' }, { slug: 'hr-1234-120' }] },
      b: { status: 'live', vehicles: [{ slug: 's-5-119' }] },
    };
    const store = { a: { updates: [] }, b: { updates: [] } };
    const billBySlug = new Map(
      [rec(119), rec(120), rec(119, { bill_type: 's', bill_number: 5 })].map((b) => [slug(b), b])
    );
    const plan = (policy?: typeof SWITCHED) =>
      planSummaries({ mode: 'nightly', moments, store: structuredClone(store), billBySlug, now: new Date('2027-02-01T15:00:00Z'), ...(policy ? { policy } : {}) });
    const today = plan();
    expect(today.map((p) => [p.momentId, Object.keys(p.statuses)])).toEqual([
      ['a', ['hr-1234-119', 'hr-1234-120']],
      ['b', ['s-5-119']],
    ]);
    const switched = plan(SWITCHED);
    expect(switched.map((p) => [p.momentId, Object.keys(p.statuses)])).toEqual([['a', ['hr-1234-120']]]);
  });
});

test.describe('the vote sync progress marker orders the Congress first', () => {
  test("the 120th's first roll is ahead of the 119th's last, never behind", () => {
    expect(cursorIsAhead('120-1-1', '119-2-321')).toBe(true);
    expect(cursorIsAhead('119-2-321', '120-1-1')).toBe(false);
    expect(cursorIsAhead('120-1-5', '119-2-4')).toBe(true);
    expect(cursorIsAhead('119-2-500', '120-1-1')).toBe(false);
    expect(cursorIsAhead('120-1-1', null)).toBe(true);
    expect(cursorIsAhead('120-1-1', '')).toBe(true);
  });

  test('inside one Congress it is exactly the old session-then-roll rule', () => {
    // The rule sync-votes.mjs applied before 2026-11-12, verbatim.
    const old = (next: string, prev: string | null) => {
      const [, session, high] = next.split('-').map(Number);
      const [, ps, pr] = prev ? prev.split('-').map(Number) : [0, 0, 0];
      return !prev || session > ps || (session === ps && high > pr);
    };
    for (const prev of [null, '119-1-0', '119-1-300', '119-2-0', '119-2-321']) {
      for (const s of [1, 2]) {
        for (const r of [0, 1, 299, 300, 301, 321, 322, 900]) {
          const next = `119-${s}-${r}`;
          expect(cursorIsAhead(next, prev), `${next} vs ${prev}`).toBe(old(next, prev));
        }
      }
    }
  });
});

// --------------------------------------------------------------------------
// 3. The guard: no per-bill Congress.gov address from the tracked number
// --------------------------------------------------------------------------

test.describe('no pipeline code builds a per-bill Congress.gov address from the tracked number', () => {
  const ROOTS = ['scripts', 'lib', join('app', 'api')];
  const SOURCE = /\.(?:mjs|js|cjs|ts|tsx)$/;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (SOURCE.test(name)) files.push(p);
    }
  };
  for (const r of ROOTS) walk(join(process.cwd(), r));
  const isComment = (line: string) => /^\s*(\*|\/\/|\/\*)/.test(line);
  const scan = (re: RegExp, allow: (file: string, line: string) => boolean = () => false) =>
    files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => re.test(line) && !isComment(line) && !allow(relative(process.cwd(), f), line))
        .map(({ i }) => `${relative(process.cwd(), f)}:${i + 1}`)
    );

  test('every per-bill API path goes through billApiPath (scripts/congress-fetch.mjs)', () => {
    // `/bill/${…}/…` in a template: a Congress segment followed by more path.
    // The list endpoints (`/bill/${CONGRESS}` with nothing after) ask for the
    // tracked Congress's list on purpose and are not matched.
    const perBill = /\/bill\/\$\{[^}]+\}\//;
    const offenders = scan(
      perBill,
      (file, line) => file === join('scripts', 'congress-fetch.mjs') && line.includes('return `/bill/${congress}/${type}/${number}${suffix}`')
    );
    expect(offenders).toEqual([]);
  });

  test('no per-bill path is concatenated by hand either', () => {
    expect(scan(/['"`]\/bill\/['"`]\s*\+/)).toEqual([]);
  });

  test('no record link names the tracked Congress', () => {
    expect(scan(/\$\{\s*(?:CONGRESS|CURRENT_CONGRESS\.number|NUMBER)\s*\}th-congress/)).toEqual([]);
  });

  test("billApiPath itself reads the bill's Congress, never the tracked one", () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'congress-fetch.mjs'), 'utf8');
    const body = src.slice(src.indexOf('export function billApiPath'), src.indexOf('export async function fetchRecentlyUpdated'));
    expect(body).toContain('congressOfBill(bill)');
    expect(body).not.toMatch(/\bCONGRESS\b/);
  });
});
