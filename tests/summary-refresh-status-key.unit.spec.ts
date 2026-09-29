import { expect, test } from '@playwright/test';
import bills from '../data/bills.json';
import { statusKeyFor as statusKeyForTs, type StatusKeyBill } from '../lib/journey';
import {
  SCHEMA_VERSION,
  STATUS_KEY_READINGS,
  checkMomentUpdates,
  isStatusReading,
  statusKeyChanges,
  summaryNeedsRefresh,
  summaryRefreshReason,
} from '../lib/moment-updates-gate.mjs';
import { revisionReasons } from '../lib/moments-ui';
import {
  generateStateSummary,
  planSummaries,
  recordOnlyRevision,
  recordStatusKey,
  recordStatusKeys,
} from '../scripts/moment-updates.mjs';

/*
 * A "WHERE IT STANDS" SUMMARY IS REWRITTEN WHEN THE PAGE'S READING OF A
 * MEASURE CHANGES (2026-09-29).
 *
 * The iran-war-powers revision s_5341187d (2026-09-26) says "H. Con. Res. 86
 * is also listed as Passed one chamber". Since #368 the bill page reads the
 * same record as "Adopted by both chambers", and since #382 the summary writer
 * is handed that reading. But the nightly decided whether to rewrite by
 * comparing RAW statuses (summaryRefreshReason), and H.Con.Res. 86's raw
 * status is still `passed_chamber`. So nothing counted as movement, and the
 * false line would have stood until the 7-day re-anchor.
 *
 * The fix: every new revision stores the status key each measure was
 * described by (`grounded_in.vehicle_status_keys`), and the nightly counts a
 * changed key as movement. A revision written before the fix has no stored
 * key. For it, the key its writer used is worked out from the raw status:
 * before #382 no writer read the passage readings, so `passed_chamber` was
 * handed as itself. A `floor_vote` measure is skipped, because its key was
 * clocked from a record the revision does not store.
 *
 * A key change is a reason to rewrite, not a reason the page prints. The
 * page prints every `status:` token in `changed_because` as "a bill on this
 * question moved to a different stage", and H.Con.Res. 86 did not move: it
 * was adopted on 2026-06-23. So the rewrite's `changed_because` names only
 * what is true (new actions, or the days since the last version).
 *
 * Every fixture below is verbatim from the committed data as of 2026-09-29:
 * the s_5341187d grounding from data/moment-updates.json, and the bill rows
 * from data/bills.json. The rows for S.J.Res. 185 and S. 3172 have no status
 * basis fields there, and none is added here. The one exception is labelled
 * where it is built: the keyed revision in the floor-clock tests is SYNTHETIC,
 * because no keyed revision exists yet.
 *
 * ZERO network and ZERO model calls. The one Anthropic client here is a stub
 * that returns a fixed reply.
 */

const H86 = {
  full_identifier: 'hconres-86-119',
  bill_type: 'hconres',
  bill_number: 86,
  status: 'passed_chamber',
  last_action_date: '2026-06-24',
  last_action_text: 'Message on Senate action sent to the House.',
  status_basis_text:
    'Resolution agreed to in Senate without amendment by Yea-Nay Vote. 50 - 48. Record Vote Number: 184. (consideration: CR S3039-3040)',
  status_basis_date: '2026-06-23',
};
const H93 = {
  full_identifier: 'hconres-93-119',
  bill_type: 'hconres',
  bill_number: 93,
  status: 'passed_chamber',
  last_action_date: '2026-09-16',
  last_action_text: 'Received in the Senate and referred to the Committee on Foreign Relations.',
};
const SJ185 = {
  full_identifier: 'sjres-185-119',
  bill_type: 'sjres',
  bill_number: 185,
  status: 'floor_vote',
  last_action_date: '2026-06-24',
  last_action_text:
    'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 192. (CR S3194)',
};
/** A real calendar placement, dated 2026-07-27: `floor_vote_stale` by 2026-09-29. */
const S3172 = {
  full_identifier: 's-3172-119',
  bill_type: 's',
  bill_number: 3172,
  status: 'floor_vote',
  last_action_date: '2026-07-27',
  last_action_text: 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 501.',
};

type Row = { full_identifier: string; bill_type: string; status: string; last_action_date: string; last_action_text: string; status_basis_text?: string };

/** What planSummaries puts in its `records` map for one bill. */
const recordOf = (b: Row) => ({
  lastActionText: b.last_action_text,
  lastActionDate: b.last_action_date,
  billType: b.bill_type,
  statusBasisText: b.status_basis_text ?? null,
});

/** iran-war-powers s_5341187d's grounding, verbatim (its refs left out; nothing here reads them). */
const S_5341187D_STATUSES = {
  'hconres-93-119': 'passed_chamber',
  'hconres-89-119': 'floor_vote',
  'hconres-86-119': 'passed_chamber',
  'sjres-185-119': 'floor_vote',
  'sjres-200-119': 'committee',
  'sjres-211-119': 'committee',
  'sjres-180-119': 'floor_vote',
  'sjres-181-119': 'floor_vote',
  'sjres-172-119': 'floor_vote',
  'hconres-38-119': 'floor_vote',
};
const S_5341187D = {
  id: 's_5341187d',
  generated_at: '2026-09-26T18:09:58.193Z',
  as_of_day: '2026-09-26',
  grounded_in: {
    vehicle_statuses: S_5341187D_STATUSES,
    update_ids: ['u_40aa8bf1', 'u_fe66be12', 'u_470e18ff', 'u_06fa2260'],
    roll_calls: ['s-119-2-244', 'h-119-2-307'],
  },
  changed_because: ['status:hconres-89-119 passed_chamber→floor_vote'],
  model: 'claude-sonnet-5',
};

/** The next nightly after this fix could merge: 2026-09-30, 14:15 UTC. */
const NEXT_NIGHTLY = Date.parse('2026-09-30T14:15:00Z');

/** The three measures of s_5341187d this spec carries rows for. */
const ROWS = [H86, H93, SJ185];
const statusesOf = (rows: Row[]) => Object.fromEntries(rows.map((b) => [b.full_identifier, b.status]));
const recordsOf = (rows: Row[]) => Object.fromEntries(rows.map((b) => [b.full_identifier, recordOf(b)]));

test.describe('the status keys a revision is compared on', () => {
  test('the page reads H.Con.Res. 86 as adopted, H.Con.Res. 93 as passed one chamber, S.J.Res. 185 as floor activity', () => {
    expect(recordStatusKeys(statusesOf(ROWS), recordsOf(ROWS), NEXT_NIGHTLY)).toEqual({
      'hconres-86-119': 'adopted',
      'hconres-93-119': 'passed_chamber',
      'sjres-185-119': 'floor_activity',
    });
    // The same keys the site's own reader gives (lib/journey.ts).
    for (const b of ROWS) expect(statusKeyForTs(b as unknown as StatusKeyBill, NEXT_NIGHTLY)).toBe(recordStatusKey(b.status, recordOf(b), NEXT_NIGHTLY));
  });
});

test.describe('summaryRefreshReason · a changed status key is movement', () => {
  const entry = { updates: [], summary_revisions: [S_5341187D] };
  const statuses = { 'hconres-86-119': 'passed_chamber', 'hconres-93-119': 'passed_chamber', 'sjres-185-119': 'floor_vote' };
  const statusKeys = { 'hconres-86-119': 'adopted', 'hconres-93-119': 'passed_chamber', 'sjres-185-119': 'floor_activity' };

  test('the old s_5341187d, grounded in passed_chamber, against a record that now reads adopted: a refresh reason', () => {
    expect(summaryRefreshReason(entry, statuses, NEXT_NIGHTLY, { statusKeys })).toBe('status key hconres-86-119 passed_chamber→adopted');
    expect(summaryNeedsRefresh(entry, statuses, NEXT_NIGHTLY, { statusKeys })).toBe(true);
    expect(statusKeyChanges(S_5341187D, statusKeys, statuses)).toEqual([{ slug: 'hconres-86-119', from: 'passed_chamber', to: 'adopted' }]);
  });

  test('without the keys, the raw comparison alone finds nothing: the bug this fixes', () => {
    expect(summaryRefreshReason(entry, statuses, NEXT_NIGHTLY)).toBeNull();
  });

  test('an unchanged key gives no reason: H.Con.Res. 93 still reads passed one chamber', () => {
    const only93 = { 'hconres-93-119': 'passed_chamber' };
    expect(summaryRefreshReason(entry, only93, NEXT_NIGHTLY, { statusKeys: { 'hconres-93-119': 'passed_chamber' } })).toBeNull();
  });

  test('a revision that stored its keys is compared with them, and an unchanged key gives no reason', () => {
    const keyed = { ...S_5341187D, grounded_in: { ...S_5341187D.grounded_in, vehicle_status_keys: { ...statusKeys } } };
    expect(summaryRefreshReason({ updates: [], summary_revisions: [keyed] }, statuses, NEXT_NIGHTLY, { statusKeys })).toBeNull();
  });

  test('an old revision with no key: a floor_vote measure is skipped, because its clocked key cannot be rebuilt', () => {
    // s_5341187d's text calls S.J.Res. 185 "Floor activity", and it reads that
    // way now. Comparing the key against the raw `floor_vote` would call that a
    // change, on every old revision with a floor measure.
    const onlyFloor = { 'sjres-185-119': 'floor_vote' };
    expect(summaryRefreshReason(entry, onlyFloor, NEXT_NIGHTLY, { statusKeys: { 'sjres-185-119': 'floor_activity' } })).toBeNull();
  });

  test('a status its own sentence does not support is held back, for the key as for the raw status', () => {
    expect(summaryRefreshReason(entry, statuses, NEXT_NIGHTLY, { statusKeys, unsupported: new Set(['hconres-86-119']) })).toBeNull();
  });

  test('a raw status change is still reported as one, and not twice', () => {
    const moved = { ...statuses, 'hconres-93-119': 'signed' };
    expect(summaryRefreshReason(entry, moved, NEXT_NIGHTLY, { statusKeys: { ...statusKeys, 'hconres-93-119': 'signed' } })).toBe('status hconres-93-119');
    expect(statusKeyChanges(S_5341187D, { ...statusKeys, 'hconres-93-119': 'signed' }, moved).map((c) => c.slug)).toEqual(['hconres-86-119']);
  });

  test('a new revision with nothing changed is not rewritten', () => {
    const fresh = {
      ...S_5341187D,
      generated_at: '2026-09-30T14:16:00Z',
      grounded_in: { ...S_5341187D.grounded_in, vehicle_status_keys: { ...statusKeys } },
    };
    expect(summaryRefreshReason({ updates: [], summary_revisions: [fresh] }, statuses, Date.parse('2026-10-01T14:15:00Z'), { statusKeys })).toBeNull();
  });
});

test.describe('the floor clock alone is not movement', () => {
  // SYNTHETIC: a revision that stored S. 3172's key while its placement was
  // fresh. No keyed revision exists before this change.
  const keyedAt = (key: string) => ({
    id: 's_00000001',
    generated_at: '2026-07-28T14:15:00Z',
    grounded_in: { vehicle_statuses: { 's-3172-119': 'floor_vote' }, vehicle_status_keys: { 's-3172-119': key }, update_ids: [] },
  });
  const raw = { 's-3172-119': 'floor_vote' };
  const at = Date.parse('2026-08-02T14:15:00Z');

  test('a placement aging past its window (floor_vote → floor_vote_stale) buys no rewrite', () => {
    expect(recordStatusKey('floor_vote', recordOf(S3172), Date.parse('2026-07-28T14:15:00Z'))).toBe('floor_vote');
    expect(recordStatusKey('floor_vote', recordOf(S3172), Date.parse('2026-09-29T14:15:00Z'))).toBe('floor_vote_stale');
    expect(summaryRefreshReason({ updates: [], summary_revisions: [keyedAt('floor_vote')] }, raw, at, { statusKeys: { 's-3172-119': 'floor_vote_stale' } })).toBeNull();
  });

  test('a stored floor key that moves any other way is movement', () => {
    expect(summaryRefreshReason({ updates: [], summary_revisions: [keyedAt('floor_activity')] }, raw, at, { statusKeys: { 's-3172-119': 'floor_vote' } })).toBe(
      'status key s-3172-119 floor_activity→floor_vote',
    );
    expect(summaryRefreshReason({ updates: [], summary_revisions: [keyedAt('floor_vote_stale')] }, raw, at, { statusKeys: { 's-3172-119': 'floor_vote' } })).toBe(
      'status key s-3172-119 floor_vote_stale→floor_vote',
    );
  });
});

test.describe('planSummaries · the nightly plan over the real record', () => {
  const moments = {
    'iran-war-powers': { status: 'live', vehicles: ROWS.map((b) => ({ slug: b.full_identifier })) },
  };
  const billBySlug = new Map(ROWS.map((b) => [b.full_identifier, b]));

  test('the next nightly plans ONE model rewrite for iran-war-powers, for the H.Con.Res. 86 key, and carries the keys', () => {
    const plan = planSummaries({
      mode: 'nightly',
      moments,
      store: { 'iran-war-powers': { updates: [], summary_revisions: [S_5341187D] } },
      billBySlug,
      now: new Date(NEXT_NIGHTLY),
    });
    expect(plan).toHaveLength(1);
    const [p] = plan;
    expect(p.generate).toBe(true);
    expect(p.recordOnly).toBeUndefined();
    expect(p.reason).toBe('status key hconres-86-119 passed_chamber→adopted');
    expect(p.statuses).toEqual(statusesOf(ROWS));
    expect(p.statusKeys).toEqual({ 'hconres-86-119': 'adopted', 'hconres-93-119': 'passed_chamber', 'sjres-185-119': 'floor_activity' });
  });

  test('the rewrite stores the keys, says why, passes the gate, and the nightly after it finds nothing moved', async () => {
    const entry = { updates: [] as Record<string, unknown>[], summary_revisions: [S_5341187D] as Record<string, unknown>[] };
    const [p] = planSummaries({ mode: 'nightly', moments, store: { 'iran-war-powers': entry }, billBySlug, now: new Date(NEXT_NIGHTLY) });

    // A stub client with a fixed, record-grounded reply. No model is called.
    const reply = {
      en: 'On June 23, 2026, the Senate agreed to H. Con. Res. 86 by a recorded vote of 50 to 48, after the House agreed to it on June 3, 2026.',
      es: 'El 23 de junio de 2026, el Senado aprobó H. Con. Res. 86 por votación nominal de 50 a 48, después de que la Cámara la aprobó el 3 de junio de 2026.',
    };
    const stub = { messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(reply) }] }) } };
    const written = await generateStateSummary(stub, 'iran-war-powers', entry, p.statuses, [], p.records, p.votes, p.rollCallsOnRecord);
    expect(written, 'the stub reply passes the summary lint').not.toBeNull();
    if (!written) return;
    const revision = written;
    expect(revision.grounded_in.vehicle_statuses).toEqual(p.statuses);
    expect(revision.grounded_in.vehicle_status_keys).toEqual(p.statusKeys);

    // What the page prints under "Rewritten because" (lib/moments-ui.ts). No
    // `status:` token: that prints "a bill on this question moved to a
    // different stage", and H.Con.Res. 86 did not move (it was adopted on
    // 2026-06-23). With no new action, the reason is the days since the last
    // version. Every token is one the map knows, so
    // tests/moments-ui.unit.spec.ts stays green on the shipped file.
    expect(revision.changed_because).toHaveLength(1);
    expect(revision.changed_because[0]).toMatch(/^reanchor:\d+d$/);
    expect(revisionReasons(revision.changed_because).map((r) => r.key)).toEqual(['reanchor']);

    // The stored revision passes the gate that runs before every commit.
    const file = {
      _meta: { schema: SCHEMA_VERSION, generated_at: revision.generated_at },
      'iran-war-powers': { updates: [], summary_revisions: [revision] },
    };
    const gate = checkMomentUpdates(file, moments, new Set(billBySlug.keys()), { now: Date.parse(revision.generated_at) + 60_000 });
    expect(gate.violations).toEqual([]);

    // The next nightly: the stored keys match the reading, so no rewrite and
    // no loop.
    entry.summary_revisions = [S_5341187D, revision];
    const [next] = planSummaries({
      mode: 'nightly',
      moments,
      store: { 'iran-war-powers': entry },
      billBySlug,
      now: new Date(Date.parse(revision.generated_at) + 3_600_000),
    });
    expect(next.generate).toBe(false);
    expect(next.reason).toBe('nothing moved');
  });

  test('the record-only revision stores the keys too', () => {
    const statuses = statusesOf(ROWS);
    const records = recordsOf(ROWS);
    const revision = recordOnlyRevision({
      momentId: 'iran-war-powers',
      entry: { updates: [], summary_revisions: [S_5341187D] },
      statuses,
      records,
      votes: [],
      day: '2026-10-03',
      generatedAt: '2026-10-03T14:16:00.000Z',
    });
    expect(revision).not.toBeNull();
    expect(revision!.grounded_in.vehicle_status_keys).toEqual({
      'hconres-86-119': 'adopted',
      'hconres-93-119': 'passed_chamber',
      'sjres-185-119': 'floor_activity',
    });
    expect(revision!.changed_because.some((t: string) => t.startsWith('status:'))).toBe(false);
  });

  test('a real update since the revision is still named as one, beside the key change', () => {
    // SYNTHETIC update row: a new action recorded after s_5341187d. Only its
    // id and recorded_at are read here.
    const entry = {
      updates: [{ id: 'u_00000001', class: 'floor_action', vehicle: 'hconres-86-119', day: '2026-09-30', recorded_at: '2026-09-30T13:00:00Z' }],
      summary_revisions: [S_5341187D],
    };
    const revision = recordOnlyRevision({
      momentId: 'iran-war-powers',
      entry,
      statuses: statusesOf(ROWS),
      records: recordsOf(ROWS),
      votes: [],
      day: '2026-09-30',
      generatedAt: '2026-09-30T14:16:00.000Z',
    });
    expect(revision!.changed_because).toEqual(['updates:+1']);
  });
});

test.describe('checkMomentUpdates · vehicle_status_keys', () => {
  const moments = { 'iran-war-powers': { status: 'live', vehicles: ROWS.map((b) => ({ slug: b.full_identifier })) } };
  const slugs = new Set(ROWS.map((b) => b.full_identifier));
  const NOW = Date.parse('2026-09-30T15:00:00Z');
  const revision = (grounded: Record<string, unknown>) => ({
    id: 's_00000001',
    generated_at: '2026-09-30T14:16:00Z',
    as_of_day: '2026-09-30',
    text: {
      en: 'On June 23, 2026, the Senate agreed to H. Con. Res. 86 by a recorded vote of 50 to 48.',
      es: 'El 23 de junio de 2026, el Senado aprobó H. Con. Res. 86 por votación nominal de 50 a 48.',
    },
    grounded_in: { update_ids: [], refs: [], ...grounded },
    changed_because: ['reanchor:4d'],
    model: 'claude-sonnet-5-5',
  });
  const run = (grounded: Record<string, unknown>) =>
    checkMomentUpdates(
      { _meta: { schema: SCHEMA_VERSION, generated_at: '2026-09-30T14:16:00Z' }, 'iran-war-powers': { updates: [], summary_revisions: [revision(grounded)] } },
      moments,
      slugs,
      { now: NOW },
    ).violations;
  const statuses = statusesOf(ROWS);

  test('a revision with no keys, as every revision before 2026-09-29 is, still passes', () => {
    expect(run({ vehicle_statuses: statuses })).toEqual([]);
  });

  test('a revision whose keys are readings of its statuses passes', () => {
    expect(run({ vehicle_statuses: statuses, vehicle_status_keys: { 'hconres-86-119': 'adopted', 'hconres-93-119': 'passed_chamber', 'sjres-185-119': 'floor_activity' } })).toEqual([]);
  });

  test('a key that is not a reading of the status fails', () => {
    const v = run({ vehicle_statuses: statuses, vehicle_status_keys: { 'hconres-86-119': 'adopted', 'hconres-93-119': 'passed_chamber', 'sjres-185-119': 'adopted' } });
    expect(v).toEqual([expect.stringContaining('"adopted" is not a reading of "sjres-185-119"\'s status "floor_vote"')]);
  });

  test('a key for a measure with no status, or a measure with no key, fails', () => {
    const extra = run({ vehicle_statuses: { 'hconres-86-119': 'passed_chamber' }, vehicle_status_keys: { 'hconres-86-119': 'adopted', 'hconres-93-119': 'passed_chamber' } });
    expect(extra).toEqual([expect.stringContaining('"hconres-93-119" has no status in grounded_in.vehicle_statuses')]);
    const missing = run({ vehicle_statuses: statuses, vehicle_status_keys: { 'hconres-86-119': 'adopted' } });
    expect(missing.length).toBe(2);
    expect(missing.every((m: string) => m.includes('vehicle_status_keys: missing'))).toBe(true);
  });

  test('a key map that is empty or not a map fails', () => {
    for (const bad of [{}, [], 'adopted', null]) {
      expect(run({ vehicle_statuses: statuses, vehicle_status_keys: bad })).toEqual([expect.stringContaining('must be a non-empty { slug: status key } map')]);
    }
  });
});

test.describe('STATUS_KEY_READINGS covers every key both statusKeyFor copies return', () => {
  const corpus = bills as unknown as (StatusKeyBill & Record<string, unknown>)[];

  test('over every bill in data/bills.json, at one instant', () => {
    const now = Date.now();
    const off: string[] = [];
    for (const b of corpus) {
      const rec = {
        lastActionText: (b.last_action_text as string | null) ?? null,
        lastActionDate: (b.last_action_date as string | null) ?? null,
        billType: (b.bill_type as string | null) ?? null,
        statusBasisText: (b.status_basis_text as string | null) ?? null,
      };
      const script = recordStatusKey(b.status, rec, now);
      const site = statusKeyForTs(b, now);
      if (!isStatusReading(b.status, script) || !isStatusReading(b.status, site)) off.push(`${b.full_identifier}: ${b.status} → ${script} / ${site}`);
    }
    expect(off).toEqual([]);
  });

  test('the table lists only the two statuses that are read more than one way', () => {
    expect(Object.keys(STATUS_KEY_READINGS).sort()).toEqual(['floor_vote', 'passed_chamber']);
    expect(isStatusReading('committee', 'committee')).toBe(true);
    expect(isStatusReading('committee', 'floor_activity')).toBe(false);
  });
});
