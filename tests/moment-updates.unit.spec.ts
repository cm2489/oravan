import { expect, test } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
// Relative import of the (near-)import-free gate module — the logic
// scripts/check-moment-updates.mjs executes in CI. Its ONE import is
// lib/moments-gate.mjs (itself import-free), so the chain loads under
// Playwright's transform, exactly like tests/moments.unit.spec.ts.
import {
  ACTION_TEXT_KEY_CHARS,
  CLASS_PRIORITY,
  HARD_DAY_CEILING,
  MAX_REVISIONS,
  MAX_UPDATES_PER_MOMENT,
  RENDER_DAY_CAP,
  RETENTION_DAYS,
  SCHEMA_VERSION,
  SIZE_FAIL_BYTES,
  SIZE_WARN_BYTES,
  SOURCE_KINDS,
  UPDATE_CLASSES,
  checkMomentUpdates,
  computeUpdateId,
  dedupeUpdates,
  etDay,
  fnv1a,
  groupByDay,
  identityKey,
  lintRevisionText,
  lintUpdateText,
  pruneEntry,
  selectDayUpdates,
  shiftDay,
  summaryNeedsRefresh,
  updateId,
} from '../lib/moment-updates-gate.mjs';
import {
  RENDER_DAY_CAP as READER_RENDER_DAY_CAP,
  RETENTION_DAYS as READER_RETENTION_DAYS,
  SCHEMA_VERSION as READER_SCHEMA_VERSION,
  getCurrentSummary,
  getRevisions,
  getUpdates,
  groupUpdatesByDay,
  latestUpdateDay,
} from '../lib/moment-updates';

const repo = (p: string) => join(__dirname, '..', p);
const read = (p: string) => JSON.parse(readFileSync(repo(p), 'utf8'));

/** The exact real-data run the CI gate performs (scripts/check-moment-updates.mjs). */
function checkRepoData() {
  const updates = read('data/moment-updates.json');
  const moments = read('data/moments.json');
  const bills: { full_identifier: string }[] = read('data/bills.json');
  const billSlugs = new Set(bills.map((b) => b.full_identifier));
  const fileBytes = statSync(repo('data/moment-updates.json')).size;
  return checkMomentUpdates(updates, moments, billSlugs, { fileBytes });
}

/* ------------------------------------------------------------------ *
 * 1 · The real data/moment-updates.json IS gated by this suite.
 * ------------------------------------------------------------------ */
test.describe('real data/moment-updates.json passes the CI gate', () => {
  test('zero violations against the live moments + corpus', () => {
    const { violations } = checkRepoData();
    expect(violations).toEqual([]);
  });

  test('the seed is record-anchored: every non-press update carries verbatim government text', () => {
    const file = read('data/moment-updates.json');
    let seen = 0;
    for (const [id, entry] of Object.entries<{ updates?: Record<string, unknown>[] }>(file)) {
      if (id === '_meta') continue;
      for (const u of entry.updates ?? []) {
        seen++;
        if (u.class === 'press_cluster') {
          expect(u.record, `${id}/${u.id}`).toBeNull();
        } else {
          const record = u.record as { action_text?: string } | null;
          expect(record?.action_text?.length, `${id}/${u.id}`).toBeGreaterThan(0);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  test('the reader reads the same file the gate validated', () => {
    const file = read('data/moment-updates.json');
    for (const id of Object.keys(file)) {
      if (id === '_meta') continue;
      expect(getUpdates(id).length).toBe(file[id].updates.length);
      expect(getRevisions(id).length).toBe(file[id].summary_revisions.length);
      expect(getCurrentSummary(id)?.id).toBe(file[id].summary_revisions.at(-1)?.id);
      const days = file[id].updates.map((u: { day: string }) => u.day).sort();
      expect(latestUpdateDay(id)).toBe(days.at(-1));
    }
  });

  test('an unknown moment reads as an empty timeline, never as an error', () => {
    expect(getUpdates('not-a-real-moment')).toEqual([]);
    expect(getRevisions('not-a-real-moment')).toEqual([]);
    expect(getCurrentSummary('not-a-real-moment')).toBeUndefined();
    expect(latestUpdateDay('not-a-real-moment')).toBeUndefined();
    // _meta is a metadata key, never a moment.
    expect(getUpdates('_meta')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · etDay — the ET calendar day, never the UTC bucket.
 * ------------------------------------------------------------------ */
test.describe('etDay', () => {
  test('an ET-evening instant stays on its own ET day', () => {
    expect(etDay('2026-07-24T23:30:00-04:00')).toBe('2026-07-24');
  });

  test('the UTC-bucket bug: 01:00Z belongs to the PREVIOUS ET day', () => {
    expect(etDay('2026-07-25T01:00:00Z')).toBe('2026-07-24');
    // The naive read would have said 2026-07-25 — that is the bug, pinned.
    expect(new Date('2026-07-25T01:00:00Z').toISOString().slice(0, 10)).toBe('2026-07-25');
  });

  test('March DST boundary: the same wall-clock UTC time lands differently either side', () => {
    // DST 2026 starts Sunday 2026-03-08 at 02:00 ET. Before it, ET is UTC-5.
    expect(etDay('2026-03-08T04:59:00Z')).toBe('2026-03-07');
    // After it, ET is UTC-4, so 03:59Z is still the previous ET evening.
    expect(etDay('2026-03-09T03:59:00Z')).toBe('2026-03-08');
    // Same 04:30Z instant, EST vs EDT: one rolls back a day, one does not.
    expect(etDay('2026-03-08T04:30:00Z')).toBe('2026-03-07');
    expect(etDay('2026-07-08T04:30:00Z')).toBe('2026-07-08');
  });

  test('November DST boundary: the fall-back day resolves both offsets to one date', () => {
    // DST 2026 ends Sunday 2026-11-01 at 02:00 ET (06:00Z).
    expect(etDay('2026-11-01T04:30:00Z')).toBe('2026-11-01'); // still EDT (-4)
    expect(etDay('2026-11-02T04:30:00Z')).toBe('2026-11-01'); // now EST (-5)
    expect(etDay('2026-11-02T05:30:00Z')).toBe('2026-11-02');
  });

  test('a bare day label is returned verbatim — re-reading it as UTC would shift it back a day', () => {
    expect(etDay('2026-07-21')).toBe('2026-07-21');
    expect(etDay('2026-01-01')).toBe('2026-01-01');
  });

  test('a Date and an epoch number work; garbage returns empty string', () => {
    expect(etDay(new Date('2026-07-25T01:00:00Z'))).toBe('2026-07-24');
    expect(etDay(Date.parse('2026-07-25T01:00:00Z'))).toBe('2026-07-24');
    expect(etDay('not a date')).toBe('');
  });

  test('shiftDay is pure calendar math across a month and a DST boundary', () => {
    expect(shiftDay('2026-07-01', -1)).toBe('2026-06-30');
    expect(shiftDay('2026-03-07', 2)).toBe('2026-03-09');
    expect(shiftDay('2026-07-25', -RETENTION_DAYS)).toBe('2026-05-26');
  });
});

/* ------------------------------------------------------------------ *
 * 3 · Ids — deterministic, normalized, content-addressed.
 * ------------------------------------------------------------------ */
test.describe('update ids', () => {
  test('fnv1a is stable and 8 hex digits', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
    expect(fnv1a('hello')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a('hello')).not.toBe(fnv1a('hellp'));
  });

  const base = {
    class: 'vote',
    vehicle: 'hr-9770-119',
    day: '2026-07-21',
    record: {
      action_text: 'On passage Passed by the Yeas and Nays: 220 - 205 (Roll no. 272).',
      action_code: 'H37100',
      action_type: 'Floor',
      source_system: 'House floor actions',
      roll_call: { chamber: 'house', number: 272 },
    },
  };

  test('the same event hashes to the same id every time', () => {
    expect(computeUpdateId('m', base)).toBe(computeUpdateId('m', { ...base }));
    expect(computeUpdateId('m', base)).toMatch(/^u_[0-9a-f]{8}$/);
  });

  test('whitespace and case in action text do NOT change the id', () => {
    const voteless = {
      class: 'floor_action',
      vehicle: 'hr-9770-119',
      day: '2026-07-22',
      record: {
        action_text: 'Received in the Senate.',
        action_code: null,
        action_type: 'IntroReferral',
        source_system: 'Senate',
      },
    };
    const noisy = {
      ...voteless,
      record: { ...voteless.record, action_text: '  RECEIVED   in the\n Senate. ' },
    };
    expect(computeUpdateId('m', noisy)).toBe(computeUpdateId('m', voteless));
  });

  test('a different moment, class, vehicle, or day changes the id', () => {
    const id = computeUpdateId('m', base);
    expect(computeUpdateId('other', base)).not.toBe(id);
    expect(computeUpdateId('m', { ...base, class: 'floor_action' })).not.toBe(id);
    expect(computeUpdateId('m', { ...base, vehicle: 's-1-119' })).not.toBe(id);
    expect(computeUpdateId('m', { ...base, day: '2026-07-22' })).not.toBe(id);
  });

  test('updateId accepts the five parts as an array or as a named object', () => {
    const parts = ['m', 'vote', 'hr-9770-119', '2026-07-21', 'roll:house:272'];
    expect(updateId(parts)).toBe(
      updateId({
        momentId: 'm',
        class: 'vote',
        vehicle: 'hr-9770-119',
        occurredKey: '2026-07-21',
        identityKey: 'roll:house:272',
      }),
    );
  });

  test('identityKey: a roll call keys on chamber + number; voteless keys on code + text', () => {
    expect(identityKey(base)).toBe('roll:house:272');
    const senate = {
      record: { action_text: 'Received in the Senate.', action_code: null, action_type: 'IntroReferral' },
    };
    // Senate actions carry a NULL actionCode — the type is the fallback.
    expect(identityKey(senate)).toBe('act:introreferral:received in the senate.');
    // Long action text is truncated to a bounded key.
    const long = { record: { action_text: 'x'.repeat(400), action_code: 'H1' } };
    expect(identityKey(long)).toBe(`act:h1:${'x'.repeat(ACTION_TEXT_KEY_CHARS)}`);
  });

  test('a press cluster keys on its sorted outlet set, order-independent', () => {
    const a = { source: { outlets: ['reuters.com', 'apnews.com'] } };
    const b = { source: { outlets: ['APNEWS.com', 'Reuters.com'] } };
    expect(identityKey(a)).toBe(identityKey(b));
    expect(identityKey(a)).toBe('press:apnews.com,reuters.com');
  });
});

/* ------------------------------------------------------------------ *
 * 4 · Dedupe — the live-API findings, pinned.
 * ------------------------------------------------------------------ */
test.describe('dedupeUpdates', () => {
  const houseVote = {
    id: 'u_00000001',
    class: 'vote',
    vehicle: 'hr-9770-119',
    day: '2026-07-21',
    record: {
      action_text: 'On passage Passed by the Yeas and Nays: 220 - 205 (Roll no. 272). (text: CR H4731-4733)',
      action_code: 'H37100',
      action_type: 'Floor',
      source_system: 'House floor actions',
      roll_call: { chamber: 'house', number: 272 },
    },
  };
  /**
   * The Library of Congress echo of the SAME event: different action code,
   * different text, same roll number (live-verified 2026-07-25).
   */
  const locEcho = {
    id: 'u_00000002',
    class: 'vote',
    vehicle: 'hr-9770-119',
    day: '2026-07-21',
    record: {
      action_text: 'Passed/agreed to in House: On passage Passed by the Yeas and Nays: 220 - 205 (Roll no. 272).',
      action_code: '8000',
      action_type: 'Floor',
      source_system: 'Library of Congress',
      roll_call: { chamber: 'house', number: 272 },
    },
  };

  test('the same action seen twice collapses to one', () => {
    expect(dedupeUpdates([houseVote], [{ ...houseVote }])).toHaveLength(1);
    expect(dedupeUpdates([], [houseVote, { ...houseVote }])).toHaveLength(1);
  });

  test('the LOC echo collapses into the chamber record, whichever order it arrives in', () => {
    const a = dedupeUpdates([houseVote], [locEcho]);
    expect(a).toHaveLength(1);
    expect(a[0].record.source_system).toBe('House floor actions');

    const b = dedupeUpdates([locEcho], [houseVote]);
    expect(b).toHaveLength(1);
    expect(b[0].record.source_system).toBe('House floor actions');
  });

  test('a record-class event suppresses a scheduled signal for the same vehicle-day', () => {
    const scheduled = {
      id: 'u_00000003',
      class: 'scheduled',
      vehicle: 'hr-9770-119',
      day: '2026-07-21',
      record: { action_text: 'Bills this week', action_code: null, action_type: 'Schedule', source_system: 'docs.house.gov' },
    };
    const merged = dedupeUpdates([scheduled], [houseVote]);
    expect(merged.map((u) => u.class)).toEqual(['vote']);

    // A DIFFERENT vehicle-day keeps its signal — suppression is scoped.
    const otherDay = { ...scheduled, id: 'u_00000004', day: '2026-07-20' };
    const merged2 = dedupeUpdates([otherDay], [houseVote]);
    expect(merged2.map((u) => u.class).sort()).toEqual(['scheduled', 'vote']);
  });

  test('two clusters with the same outlet set on the same day collapse to one', () => {
    const cluster = (id: string, headline: string) => ({
      id,
      class: 'press_cluster',
      vehicle: 'hr-9770-119',
      day: '2026-07-21',
      record: null,
      source: { kind: 'press', outlets: ['apnews.com', 'reuters.com'] },
      text: { en: headline, es: headline },
    });
    const merged = dedupeUpdates([cluster('u_0000000a', 'one wording')], [cluster('u_0000000b', 'other wording')]);
    expect(merged).toHaveLength(1);
    // Deterministic tie-break: id ascending, so the result never depends on order.
    expect(merged[0].id).toBe('u_0000000a');
    expect(dedupeUpdates([cluster('u_0000000b', 'b')], [cluster('u_0000000a', 'a')])[0].id).toBe('u_0000000a');
  });

  test('the merged list is newest-day-first and priority-ordered — a stable file diff', () => {
    const merged = dedupeUpdates(
      [
        { id: 'u_00000010', class: 'press_cluster', vehicle: 'v', day: '2026-07-20', record: null, source: { outlets: ['a.com', 'b.com'] } },
        { id: 'u_00000011', class: 'floor_action', vehicle: 'v', day: '2026-07-21', record: { action_text: 'x', action_code: 'A' } },
      ],
      [{ id: 'u_00000012', class: 'vote', vehicle: 'v', day: '2026-07-21', record: { action_text: 'y', action_code: 'B' } }],
    );
    expect(merged.map((u) => u.id)).toEqual(['u_00000012', 'u_00000011', 'u_00000010']);
  });

  test('pure: neither argument is mutated', () => {
    const existing = [houseVote];
    const candidates = [locEcho];
    dedupeUpdates(existing, candidates);
    expect(existing).toHaveLength(1);
    expect(candidates).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 5 · selectDayUpdates — the cap, not a quota.
 * ------------------------------------------------------------------ */
test.describe('selectDayUpdates', () => {
  const u = (id: string, klass: string) => ({ id, class: klass });

  test('eight updates render five', () => {
    const day = [
      u('u_00000001', 'floor_action'),
      u('u_00000002', 'floor_action'),
      u('u_00000003', 'floor_action'),
      u('u_00000004', 'press_cluster'),
      u('u_00000005', 'scheduled'),
      u('u_00000006', 'status_change'),
      u('u_00000007', 'vote'),
      u('u_00000008', 'floor_action'),
    ];
    expect(selectDayUpdates(day, RENDER_DAY_CAP)).toHaveLength(5);
  });

  test('priority order: vote > status_change > floor_action > scheduled > press_cluster', () => {
    const day = [
      u('u_00000001', 'press_cluster'),
      u('u_00000002', 'scheduled'),
      u('u_00000003', 'floor_action'),
      u('u_00000004', 'status_change'),
      u('u_00000005', 'vote'),
    ];
    expect(selectDayUpdates(day, 5).map((x) => x.class)).toEqual([
      'vote',
      'status_change',
      'floor_action',
      'scheduled',
      'press_cluster',
    ]);
  });

  test('a correction is NEVER crowded out — it outranks every event on its day', () => {
    const day = [
      u('u_00000001', 'vote'),
      u('u_00000002', 'vote'),
      u('u_00000003', 'status_change'),
      u('u_00000004', 'floor_action'),
      u('u_00000005', 'floor_action'),
      u('u_00000006', 'floor_action'),
      u('u_zzzzzzzz', 'correction'),
    ];
    const rendered = selectDayUpdates(day, RENDER_DAY_CAP);
    expect(rendered).toHaveLength(5);
    expect(rendered[0].id).toBe('u_zzzzzzzz');
  });

  test('the tie-break is deterministic: same priority sorts by id ascending, input order irrelevant', () => {
    const forward = selectDayUpdates([u('u_0000000b', 'vote'), u('u_0000000a', 'vote')], 2);
    const backward = selectDayUpdates([u('u_0000000a', 'vote'), u('u_0000000b', 'vote')], 2);
    expect(forward.map((x) => x.id)).toEqual(['u_0000000a', 'u_0000000b']);
    expect(backward.map((x) => x.id)).toEqual(forward.map((x) => x.id));
  });
});

/* ------------------------------------------------------------------ *
 * 6 · Caps — warn above the render cap, fail above the ceiling.
 * ------------------------------------------------------------------ */
const NOW = new Date('2026-07-25T18:00:00Z').getTime();
const SLUGS = new Set(['test-bill-1', 'test-bill-2']);
const MOMENTS = {
  'example-moment': {
    status: 'live',
    vehicles: [{ slug: 'test-bill-1' }, { slug: 'test-bill-2' }],
  },
};

/** A valid vote update, id computed by the canonical recipe. */
function makeUpdate(over: Record<string, unknown> = {}, momentId = 'example-moment') {
  const draft = {
    class: 'vote',
    vehicle: 'test-bill-1',
    day: '2026-07-24',
    occurred_at: '2026-07-24',
    occurred_precision: 'day',
    recorded_at: '2026-07-25T02:00:00Z',
    text: { en: 'The House passed the bill, 220-205.', es: 'La Cámara aprobó el proyecto, 220-205.' },
    source: { kind: 'congress_actions', refs: ['https://www.congress.gov/example'] },
    record: {
      action_text: 'On passage Passed by the Yeas and Nays: 220 - 205 (Roll no. 272).',
      action_code: 'H37100',
      action_type: 'Floor',
      source_system: 'House floor actions',
      roll_call: { chamber: 'house', number: 272 },
    },
    ai: true,
    ...over,
  } as Record<string, unknown>;
  return { ...draft, id: computeUpdateId(momentId, draft) };
}

function makeRevision(over: Record<string, unknown> = {}) {
  return {
    id: 's_00000001',
    generated_at: '2026-07-25T03:00:00Z',
    as_of_day: '2026-07-25',
    text: {
      en: 'The House passed the bill on July 24, 2026.',
      es: 'La Cámara aprobó el proyecto el 24 de julio de 2026.',
    },
    grounded_in: { vehicle_statuses: { 'test-bill-1': 'passed_chamber' }, update_ids: [], refs: [] },
    changed_because: ['seed'],
    model: 'hand-authored',
    ...over,
  };
}

const runGate = (file: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
  checkMomentUpdates(file, MOMENTS, SLUGS, { now: NOW, ...opts });

const wrap = (updates: unknown[], revisions: unknown[] = [makeRevision()]) => ({
  _meta: { schema: SCHEMA_VERSION, generated_at: '2026-07-25T03:00:00Z' },
  'example-moment': { updates, summary_revisions: revisions },
});

/** N distinct updates on one day (distinct roll numbers => distinct ids). */
function busyDay(n: number) {
  return Array.from({ length: n }, (_, i) =>
    makeUpdate({
      class: 'floor_action',
      record: {
        action_text: `Floor action number ${i}.`,
        action_code: `H${1000 + i}`,
        action_type: 'Floor',
        source_system: 'House floor actions',
      },
    }),
  );
}

test.describe('per-day caps', () => {
  test('a 6-to-12-update day WARNS but does not fail — the store keeps every qualified event', () => {
    for (const n of [6, 12]) {
      const { violations, warnings } = runGate(wrap(busyDay(n)));
      expect(violations, `n=${n}`).toEqual([]);
      expect(warnings.some((w) => w.includes(`${n} updates`) && w.includes('cap, not quota')), `n=${n}`).toBe(true);
    }
  });

  test('a 13-update day FAILS — that is past the storage ceiling, not past the render cap', () => {
    const { violations } = runGate(wrap(busyDay(HARD_DAY_CEILING + 1)));
    expect(violations.some((v) => v.includes(`${HARD_DAY_CEILING}-per-day storage ceiling`))).toBe(true);
  });

  test('however busy the day, only RENDER_DAY_CAP render', () => {
    for (const n of [6, 12]) {
      expect(selectDayUpdates(busyDay(n), RENDER_DAY_CAP)).toHaveLength(RENDER_DAY_CAP);
    }
    // busyDay() files everything on 2026-07-24, which is yesterday at NOW.
    const yesterday = groupByDay(busyDay(12), 2, NOW).find((g) => g.day === '2026-07-24')!;
    expect(yesterday.updates).toHaveLength(12);
    expect(yesterday.rendered).toHaveLength(RENDER_DAY_CAP);
    expect(yesterday.overflow).toBe(12 - RENDER_DAY_CAP);
  });

  test('the file-size thresholds warn then fail', () => {
    expect(runGate(wrap([makeUpdate()]), { fileBytes: SIZE_WARN_BYTES }).warnings.some((w) => w.includes('warning line'))).toBe(true);
    expect(runGate(wrap([makeUpdate()]), { fileBytes: SIZE_FAIL_BYTES }).violations.some((v) => v.includes('byte ceiling'))).toBe(true);
    expect(runGate(wrap([makeUpdate()]), { fileBytes: 1024 }).violations).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 7 · The lint — the editorial law, mechanically.
 * ------------------------------------------------------------------ */
test.describe('lintUpdateText', () => {
  test('English hedges fail on every record class', () => {
    for (const klass of ['vote', 'status_change', 'floor_action', 'scheduled']) {
      const failures = lintUpdateText('The Senate is expected to vote next week.', 'en', klass);
      expect(failures.some((f) => f.includes('speculation')), klass).toBe(true);
    }
    for (const hedge of ['likely to pass', 'could pass', 'might pass', 'set to vote', 'poised to vote', 'on track to pass']) {
      expect(lintUpdateText(`The chamber is ${hedge}.`, 'en', 'vote').some((f) => f.includes('speculation')), hedge).toBe(true);
    }
  });

  test('Spanish hedges fail on every record class', () => {
    for (const klass of ['vote', 'status_change', 'floor_action', 'scheduled']) {
      const failures = lintUpdateText('Se espera que el Senado vote la próxima semana.', 'es', klass);
      expect(failures.some((f) => f.includes('speculation')), klass).toBe(true);
    }
    for (const hedge of ['probablemente vota', 'podría votar', 'podrían votar', 'estaría listo', 'estarían listos', 'está previsto que vote', 'está a punto de votar']) {
      expect(lintUpdateText(`El Senado ${hedge}.`, 'es', 'vote').some((f) => f.includes('speculation')), hedge).toBe(true);
    }
  });

  test('bare "may" is deliberately NOT a hedge — it collides with the month', () => {
    expect(lintUpdateText('The Senate returns in May 2026.', 'en', 'scheduled')).toEqual([]);
  });

  test('a flat record statement passes in both languages', () => {
    expect(lintUpdateText('The House passed the bill, 220-205, on Roll Call 272.', 'en', 'vote')).toEqual([]);
    expect(lintUpdateText('La Cámara aprobó el proyecto, 220-205, en la votación nominal 272.', 'es', 'vote')).toEqual([]);
  });

  test('the speculation lint does not apply to a press cluster — the outlet is the one speculating', () => {
    const names = ['Reuters'];
    expect(lintUpdateText('Reuters reports the vote could slip to next week.', 'en', 'press_cluster', names)).toEqual([]);
  });

  test('a press cluster that names no outlet fails, in either language', () => {
    const names = ['Reuters', 'The Associated Press'];
    expect(
      lintUpdateText('Two outlets report a delay.', 'en', 'press_cluster', names).some((f) => f.includes('names none of its outlets')),
    ).toBe(true);
    expect(
      lintUpdateText('Dos medios informan de un retraso.', 'es', 'press_cluster', names).some((f) => f.includes('names none of its outlets')),
    ).toBe(true);
    // Naming one is enough, case-insensitively.
    expect(lintUpdateText('reuters reports a delay.', 'en', 'press_cluster', names)).toEqual([]);
    expect(lintUpdateText('Reuters informa de un retraso.', 'es', 'press_cluster', names)).toEqual([]);
    // No outlet names at all is its own failure.
    expect(lintUpdateText('Someone reported a delay.', 'en', 'press_cluster', []).some((f) => f.includes('no source.outlet_names'))).toBe(true);
  });

  test('the INHERITED forbidden vocabulary still fires, in both languages', () => {
    expect(lintUpdateText('Call now to stop the bill.', 'en', 'vote').some((f) => f.includes('"stop"'))).toBe(true);
    expect(lintUpdateText('Los republicanos aprobaron la medida.', 'es', 'vote').some((f) => f.includes('nombre de partido'))).toBe(true);
    expect(lintUpdateText('Reuters called it a crisis.', 'en', 'press_cluster', ['Reuters']).some((f) => f.includes('"crisis"'))).toBe(true);
  });

  test('quoted official titles stay exempt — the inherited exemption travels with the table', () => {
    expect(lintUpdateText('The House passed the "Stop Harmful Schemes Act" of 2026.', 'en', 'vote')).toEqual([]);
    expect(lintUpdateText('La Cámara aprobó la «Ley para Detener el Fraude» de 2026.', 'es', 'vote')).toEqual([]);
  });

  test('lintRevisionText applies the vocabulary table AND the speculation lint', () => {
    expect(lintRevisionText('The Senate is expected to take it up.', 'en').some((f) => f.includes('speculation'))).toBe(true);
    expect(lintRevisionText('Se espera que el Senado la considere.', 'es').some((f) => f.includes('speculation'))).toBe(true);
    expect(lintRevisionText('Call now to stop it.', 'en').some((f) => f.includes('"stop"'))).toBe(true);
    expect(lintRevisionText('The Senate received the bill on July 22, 2026 and has not voted on it.', 'en')).toEqual([]);
  });

  test('the gate surfaces every lint failure, per language, on the real shape', () => {
    const hedged = makeUpdate({
      text: { en: 'The Senate is expected to vote.', es: 'La Cámara aprobó el proyecto, 220-205.' },
    });
    const { violations } = runGate(wrap([hedged]));
    expect(violations.some((v) => v.includes('.text.en') && v.includes('speculation'))).toBe(true);
    expect(violations.some((v) => v.includes('.text.es') && v.includes('speculation'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 8 · Parity, field by field.
 * ------------------------------------------------------------------ */
test.describe('bilingual parity', () => {
  test('an update missing its ES sibling fails', () => {
    const enOnly = makeUpdate({ text: { en: 'English only.' } });
    const { violations } = runGate(wrap([enOnly]));
    expect(violations.some((v) => v.includes('.text.es') && v.includes('bilingual-parity'))).toBe(true);
  });

  test('an update missing its EN sibling fails', () => {
    const esOnly = makeUpdate({ text: { es: 'Solo español.' } });
    const { violations } = runGate(wrap([esOnly]));
    expect(violations.some((v) => v.includes('.text.en') && v.includes('bilingual-parity'))).toBe(true);
  });

  test('an empty-string sibling is not parity', () => {
    const blank = makeUpdate({ text: { en: 'English.', es: '   ' } });
    expect(runGate(wrap([blank])).violations.some((v) => v.includes('.text.es'))).toBe(true);
  });

  test('a summary revision missing either sibling fails', () => {
    const noEs = makeRevision({ text: { en: 'Only English.' } });
    expect(runGate(wrap([makeUpdate()], [noEs])).violations.some((v) => v.includes('.text.es'))).toBe(true);
    const noEn = makeRevision({ text: { es: 'Solo español.' } });
    expect(runGate(wrap([makeUpdate()], [noEn])).violations.some((v) => v.includes('.text.en'))).toBe(true);
  });

  test('text past the 200-char ceiling fails; past the 160-char target only warns', () => {
    const long = makeUpdate({ text: { en: 'a'.repeat(201), es: 'b'.repeat(201) } });
    const { violations } = runGate(wrap([long]));
    expect(violations.filter((v) => v.includes('exceeds the 200-char ceiling'))).toHaveLength(2);

    const mid = makeUpdate({ text: { en: 'a'.repeat(170), es: 'b'.repeat(170) } });
    const res = runGate(wrap([mid]));
    expect(res.violations).toEqual([]);
    expect(res.warnings.filter((w) => w.includes('authoring target'))).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * 9 · pruneEntry — retention, caps, retired deletion.
 * ------------------------------------------------------------------ */
test.describe('pruneEntry', () => {
  const PRUNE_NOW = new Date('2026-07-25T12:00:00Z').getTime();

  test('updates older than the retention window are dropped; the boundary day is KEPT', () => {
    const cutoff = shiftDay('2026-07-25', -RETENTION_DAYS);
    const entry = {
      updates: [
        { id: 'u_00000001', class: 'vote', vehicle: 'v', day: '2026-07-24' },
        { id: 'u_00000002', class: 'vote', vehicle: 'v', day: cutoff },
        { id: 'u_00000003', class: 'vote', vehicle: 'v', day: shiftDay(cutoff, -1) },
      ],
      summary_revisions: [],
    };
    const pruned = pruneEntry(entry, { now: PRUNE_NOW })!;
    expect(pruned.updates.map((u: { id: string }) => u.id)).toEqual(['u_00000001', 'u_00000002']);
    // Pure: the input is untouched.
    expect(entry.updates).toHaveLength(3);
  });

  test('a day past the storage ceiling is trimmed BY PRIORITY — the vote is never what goes', () => {
    const updates = [
      ...Array.from({ length: HARD_DAY_CEILING + 4 }, (_, i) => ({
        id: `u_1000000${i.toString(16)}`,
        class: 'press_cluster',
        vehicle: 'v',
        day: '2026-07-24',
      })),
      { id: 'u_zzzzzzzz', class: 'vote', vehicle: 'v', day: '2026-07-24' },
    ];
    const pruned = pruneEntry({ updates, summary_revisions: [] }, { now: PRUNE_NOW })!;
    expect(pruned.updates).toHaveLength(HARD_DAY_CEILING);
    expect(pruned.updates.some((u: { class: string }) => u.class === 'vote')).toBe(true);
  });

  test('the whole-entry cap keeps the newest MAX_UPDATES_PER_MOMENT', () => {
    const updates = [];
    for (let d = 0; d < 40; d++) {
      const day = shiftDay('2026-07-25', -d);
      for (let i = 0; i < 8; i++) {
        updates.push({ id: `u_${d.toString(16).padStart(4, '0')}${i.toString(16).padStart(4, '0')}`, class: 'floor_action', vehicle: 'v', day });
      }
    }
    const pruned = pruneEntry({ updates, summary_revisions: [] }, { now: PRUNE_NOW })!;
    expect(pruned.updates).toHaveLength(MAX_UPDATES_PER_MOMENT);
    expect(pruned.updates[0].day).toBe('2026-07-25');
  });

  test('revisions are capped to the newest MAX_REVISIONS', () => {
    const summary_revisions = Array.from({ length: MAX_REVISIONS + 5 }, (_, i) => ({ id: `s_${i}` }));
    const pruned = pruneEntry({ updates: [], summary_revisions }, { now: PRUNE_NOW })!;
    expect(pruned.summary_revisions).toHaveLength(MAX_REVISIONS);
    expect(pruned.summary_revisions.at(-1)!.id).toBe(`s_${MAX_REVISIONS + 4}`);
  });

  test('a retired moment loses its entry outright — git history is the archive', () => {
    expect(pruneEntry({ updates: [{ id: 'u_1' }], summary_revisions: [] }, { retired: true })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 10 · summaryNeedsRefresh — all four triggers, and the false case.
 * ------------------------------------------------------------------ */
test.describe('summaryNeedsRefresh', () => {
  const REF_NOW = new Date('2026-07-25T12:00:00Z').getTime();
  const entry = () => ({
    updates: [{ id: 'u_1', recorded_at: '2026-07-24T10:00:00Z' }],
    summary_revisions: [
      {
        id: 's_1',
        generated_at: '2026-07-24T12:00:00Z',
        grounded_in: { vehicle_statuses: { 'test-bill-1': 'passed_chamber' }, update_ids: ['u_1'] },
      },
    ],
  });
  const statuses = { 'test-bill-1': 'passed_chamber' };

  test('false when nothing moved — a no-op run never restamps a summary', () => {
    expect(summaryNeedsRefresh(entry(), statuses, REF_NOW)).toBe(false);
  });

  test('trigger 1: no revision at all', () => {
    expect(summaryNeedsRefresh({ updates: [], summary_revisions: [] }, statuses, REF_NOW)).toBe(true);
    expect(summaryNeedsRefresh({}, statuses, REF_NOW)).toBe(true);
  });

  test('trigger 2: a vehicle status differs from what the last revision was grounded in', () => {
    expect(summaryNeedsRefresh(entry(), { 'test-bill-1': 'signed' }, REF_NOW)).toBe(true);
    // A vehicle the revision never saw at all also counts.
    expect(summaryNeedsRefresh(entry(), { ...statuses, 'test-bill-2': 'committee' }, REF_NOW)).toBe(true);
  });

  test('trigger 3: an update recorded after the revision was generated', () => {
    const e = entry();
    e.updates.push({ id: 'u_2', recorded_at: '2026-07-24T18:00:00Z' });
    expect(summaryNeedsRefresh(e, statuses, REF_NOW)).toBe(true);
  });

  test('trigger 4: the 7-day re-anchor', () => {
    const justInside = new Date('2026-07-31T11:00:00Z').getTime();
    const justOutside = new Date('2026-08-01T13:00:00Z').getTime();
    expect(summaryNeedsRefresh(entry(), statuses, justInside)).toBe(false);
    expect(summaryNeedsRefresh(entry(), statuses, justOutside)).toBe(true);
  });

  test('an unparseable generated_at fails toward refreshing, never toward a frozen summary', () => {
    const e = entry();
    e.summary_revisions[0].generated_at = 'whenever';
    expect(summaryNeedsRefresh(e, statuses, REF_NOW)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 11 · groupByDay — the quiet day is a first-class render.
 * ------------------------------------------------------------------ */
test.describe('groupByDay', () => {
  const GROUP_NOW = new Date('2026-07-25T18:00:00Z').getTime(); // 14:00 ET on 07-25

  test('every day in the window is present, newest first, with no gaps', () => {
    const groups = groupByDay([], 7, GROUP_NOW);
    expect(groups).toHaveLength(7);
    expect(groups.map((g) => g.day)).toEqual([
      '2026-07-25',
      '2026-07-24',
      '2026-07-23',
      '2026-07-22',
      '2026-07-21',
      '2026-07-20',
      '2026-07-19',
    ]);
  });

  test("a day with nothing on it is quiet; today is distinguished from the past's quiet days", () => {
    const groups = groupByDay([{ id: 'u_1', class: 'vote', day: '2026-07-23' }], 4, GROUP_NOW);
    const byDay = Object.fromEntries(groups.map((g) => [g.day, g]));

    expect(byDay['2026-07-25'].quiet).toBe(true);
    expect(byDay['2026-07-25'].isToday).toBe(true); // "nothing recorded YET today"
    expect(byDay['2026-07-24'].quiet).toBe(true);
    expect(byDay['2026-07-24'].isToday).toBe(false); // a plain past-tense line
    expect(byDay['2026-07-23'].quiet).toBe(false);
    expect(byDay['2026-07-23'].updates).toHaveLength(1);
    expect(groups.filter((g) => g.isToday)).toHaveLength(1);
  });

  test('a quiet day is COMPUTED — no stored fake update ever appears', () => {
    for (const g of groupByDay([], 5, GROUP_NOW)) {
      expect(g.updates).toEqual([]);
      expect(g.rendered).toEqual([]);
      expect(g.overflow).toBe(0);
    }
  });

  test('updates outside the window are excluded, never folded into the edge day', () => {
    const groups = groupByDay([{ id: 'u_1', class: 'vote', day: '2026-06-01' }], 3, GROUP_NOW);
    expect(groups.every((g) => g.quiet)).toBe(true);
  });

  test('the ET day, not the UTC bucket, decides which day is "today"', () => {
    // 01:00Z on 07-25 is still 07-24 in ET.
    const groups = groupByDay([], 1, new Date('2026-07-25T01:00:00Z').getTime());
    expect(groups[0].day).toBe('2026-07-24');
    expect(groups[0].isToday).toBe(true);
  });

  test('the reader groups the real seed the same way the gate module does', () => {
    const groups = groupUpdatesByDay('government-funding-deadline', 10, new Date('2026-07-25T18:00:00Z').getTime());
    expect(groups).toHaveLength(10);
    const byDay = Object.fromEntries(groups.map((g) => [g.day, g]));
    expect(byDay['2026-07-21'].updates).toHaveLength(1);
    expect(byDay['2026-07-22'].updates).toHaveLength(1);
    expect(byDay['2026-07-25'].quiet).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 12 · Drift pins — constants that must never diverge.
 * ------------------------------------------------------------------ */
test.describe('drift pins', () => {
  test('CLASS_PRIORITY covers exactly UPDATE_CLASSES, no more and no less', () => {
    expect(Object.keys(CLASS_PRIORITY).sort()).toEqual([...UPDATE_CLASSES].sort());
  });

  test('correction outranks every other class — it can never be crowded out', () => {
    const others = UPDATE_CLASSES.filter((c: string) => c !== 'correction').map((c: string) => CLASS_PRIORITY[c]);
    expect(Math.min(CLASS_PRIORITY.correction, ...others)).toBe(Math.min(...others));
    expect(CLASS_PRIORITY.correction).toBeGreaterThan(Math.max(...others));
  });

  test('the spec priority ladder is exactly vote > status_change > floor_action > scheduled > press_cluster', () => {
    expect(CLASS_PRIORITY.vote).toBeGreaterThan(CLASS_PRIORITY.status_change);
    expect(CLASS_PRIORITY.status_change).toBeGreaterThan(CLASS_PRIORITY.floor_action);
    expect(CLASS_PRIORITY.floor_action).toBeGreaterThan(CLASS_PRIORITY.scheduled);
    expect(CLASS_PRIORITY.scheduled).toBeGreaterThan(CLASS_PRIORITY.press_cluster);
  });

  test("the reader's re-exported constants ARE the gate's, not copies", () => {
    expect(READER_RENDER_DAY_CAP).toBe(RENDER_DAY_CAP);
    expect(READER_RETENTION_DAYS).toBe(RETENTION_DAYS);
    expect(READER_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
  });

  test('the spec numbers are pinned so a silent retune is a failing test', () => {
    expect(RETENTION_DAYS).toBe(60);
    expect(MAX_UPDATES_PER_MOMENT).toBe(200);
    expect(MAX_REVISIONS).toBe(30);
    expect(RENDER_DAY_CAP).toBe(5);
    expect(HARD_DAY_CEILING).toBe(12);
    expect(SIZE_WARN_BYTES).toBe(393_216);
    expect(SIZE_FAIL_BYTES).toBe(524_288);
    expect(SOURCE_KINDS).toEqual(['congress_actions', 'tier0_feed', 'press']);
  });
});

/* ------------------------------------------------------------------ *
 * 13 · The gate on fixtures — corrections, schema, membership, dates.
 * ------------------------------------------------------------------ */
test.describe('checkMomentUpdates (fixtures)', () => {
  test('a fully valid file produces zero violations', () => {
    expect(runGate(wrap([makeUpdate()])).violations).toEqual([]);
  });

  test('a correction with no `corrects` fails', () => {
    const orphan = makeUpdate({
      class: 'correction',
      record: { action_text: 'Corrected tally.', action_code: null, action_type: 'Floor', source_system: 'House floor actions' },
    });
    const { violations } = runGate(wrap([orphan]));
    expect(violations.some((v) => v.includes('.corrects') && v.includes('must name the update id'))).toBe(true);
  });

  test('a correction whose `corrects` does not resolve in the same moment fails', () => {
    const dangling = makeUpdate({
      class: 'correction',
      corrects: 'u_deadbeef',
      record: { action_text: 'Corrected tally.', action_code: null, action_type: 'Floor', source_system: 'House floor actions' },
    });
    const { violations } = runGate(wrap([makeUpdate(), dangling]));
    expect(violations.some((v) => v.includes('does not resolve inside example-moment'))).toBe(true);
  });

  test('a correction that resolves passes', () => {
    const original = makeUpdate();
    const fix = makeUpdate({
      class: 'correction',
      corrects: original.id,
      day: '2026-07-25',
      occurred_at: '2026-07-25',
      text: {
        en: 'An earlier line gave the wrong roll number; the vote was Roll Call 272.',
        es: 'Una línea anterior dio el número de votación equivocado; la votación fue la nominal 272.',
      },
      record: { action_text: 'On passage Passed by the Yeas and Nays: 220 - 205 (Roll no. 272).', action_code: 'H37100', action_type: 'Floor', source_system: 'House floor actions' },
    });
    expect(runGate(wrap([original, fix])).violations).toEqual([]);
  });

  test('an update whose vehicle is not one of THAT moment\'s vehicles fails', () => {
    const foreign = makeUpdate({ vehicle: 'test-bill-2' });
    const moments = { 'example-moment': { status: 'live', vehicles: [{ slug: 'test-bill-1' }] } };
    const { violations } = checkMomentUpdates(wrap([foreign]), moments, SLUGS, { now: NOW });
    expect(violations.some((v) => v.includes('is not one of example-moment'))).toBe(true);
  });

  test('an update whose vehicle is not in the corpus fails', () => {
    const ghost = makeUpdate({ vehicle: 'ghost-bill-99' });
    const moments = { 'example-moment': { status: 'live', vehicles: [{ slug: 'ghost-bill-99' }] } };
    const { violations } = checkMomentUpdates(wrap([ghost]), moments, SLUGS, { now: NOW });
    expect(violations.some((v) => v.includes('does not exist in data/bills.json'))).toBe(true);
  });

  test('an entry for a moment that does not exist, or one that is retired, fails', () => {
    const stray = { ...wrap([]), 'no-such-moment': { updates: [], summary_revisions: [] } };
    expect(runGate(stray).violations.some((v) => v.includes('no such moment'))).toBe(true);

    const retired = { 'example-moment': { status: 'retired', vehicles: [{ slug: 'test-bill-1' }] } };
    const res = checkMomentUpdates(wrap([makeUpdate()]), retired, SLUGS, { now: NOW });
    expect(res.violations.some((v) => v.includes('stored-retired'))).toBe(true);
  });

  test('a hand-typed id that does not hash to its own content fails', () => {
    const tampered = { ...makeUpdate(), id: 'u_00000000' };
    const { violations } = runGate(wrap([tampered]));
    expect(violations.some((v) => v.includes('is not the id this update\'s content hashes to'))).toBe(true);
  });

  test('the legislative day must match occurred_at — the UTC bucket is not the record', () => {
    const mismatched = makeUpdate({ day: '2026-07-23', occurred_at: '2026-07-24' });
    const { violations } = runGate(wrap([mismatched]));
    expect(violations.some((v) => v.includes('does not match occurred_at'))).toBe(true);
  });

  test('future dates fail, and recorded_at may not precede occurred_at', () => {
    const future = makeUpdate({ day: '2026-08-01', occurred_at: '2026-08-01', recorded_at: '2026-08-01T00:00:00Z' });
    const fv = runGate(wrap([future])).violations;
    expect(fv.some((v) => v.includes('.day') && v.includes('in the future'))).toBe(true);
    expect(fv.some((v) => v.includes('.occurred_at') && v.includes('in the future'))).toBe(true);

    const backwards = makeUpdate({ recorded_at: '2026-07-23T00:00:00Z' });
    expect(runGate(wrap([backwards])).violations.some((v) => v.includes('precedes occurred_at'))).toBe(true);
  });

  test('schema: unknown class, unknown source kind, non-https ref, missing ai flag, bad precision', () => {
    expect(runGate(wrap([{ ...makeUpdate(), class: 'vibes' }])).violations.some((v) => v.includes('.class'))).toBe(true);
    expect(
      runGate(wrap([makeUpdate({ source: { kind: 'twitter', refs: ['https://x.example'] } })])).violations.some((v) => v.includes('.source.kind')),
    ).toBe(true);
    expect(
      runGate(wrap([makeUpdate({ source: { kind: 'congress_actions', refs: ['http://insecure.example'] } })])).violations.some((v) =>
        v.includes('not an https URL'),
      ),
    ).toBe(true);
    expect(runGate(wrap([makeUpdate({ ai: 'yes' })])).violations.some((v) => v.includes('.ai'))).toBe(true);
    expect(runGate(wrap([makeUpdate({ occurred_precision: 'minute' })])).violations.some((v) => v.includes('.occurred_precision'))).toBe(true);
  });

  test('a non-press class with no record fails — the record ships beside the voice', () => {
    const voiceless = makeUpdate({ record: null });
    expect(runGate(wrap([voiceless])).violations.some((v) => v.includes('every non-press update ships the record'))).toBe(true);
    const empty = makeUpdate({ record: { action_text: '', action_code: null, action_type: 'Floor', source_system: 'Senate' } });
    expect(runGate(wrap([empty])).violations.some((v) => v.includes('.record.action_text'))).toBe(true);
  });

  test('a press cluster needs a null record, ≥2 refs, ≥2 distinct outlets, and outlet names', () => {
    const cluster = (over: Record<string, unknown> = {}) =>
      makeUpdate({
        class: 'press_cluster',
        record: null,
        text: {
          en: 'Reuters and The Associated Press reported the delay.',
          es: 'Reuters y The Associated Press informaron del retraso.',
        },
        source: {
          kind: 'press',
          refs: ['https://a.example/one', 'https://b.example/two'],
          outlets: ['reuters.com', 'apnews.com'],
          outlet_names: ['Reuters', 'The Associated Press'],
          leans: ['center', 'center'],
        },
        ...over,
      });

    expect(runGate(wrap([cluster()])).violations).toEqual([]);

    const oneRef = cluster({ source: { kind: 'press', refs: ['https://a.example/one'], outlets: ['reuters.com', 'apnews.com'], outlet_names: ['Reuters'] } });
    expect(runGate(wrap([oneRef])).violations.some((v) => v.includes('needs ≥2 refs'))).toBe(true);

    const oneOutlet = cluster({
      source: { kind: 'press', refs: ['https://a.example/one', 'https://a.example/two'], outlets: ['reuters.com'], outlet_names: ['Reuters'] },
    });
    expect(runGate(wrap([oneOutlet])).violations.some((v) => v.includes('≥2 DISTINCT outlets'))).toBe(true);

    const withRecord = cluster({ record: { action_text: 'x', action_code: null, action_type: 'Floor', source_system: 'Senate' } });
    expect(runGate(wrap([withRecord])).violations.some((v) => v.includes('must be null on a press_cluster'))).toBe(true);
  });

  test('revisions: chronological order, resolving update_ids, https refs, vehicles that exist', () => {
    const first = makeRevision({ id: 's_00000001', generated_at: '2026-07-24T12:00:00Z' });
    const second = makeRevision({ id: 's_00000002', generated_at: '2026-07-23T12:00:00Z' });
    expect(runGate(wrap([makeUpdate()], [first, second])).violations.some((v) => v.includes('out of order'))).toBe(true);

    const bogusIds = makeRevision({ grounded_in: { vehicle_statuses: { 'test-bill-1': 'passed_chamber' }, update_ids: ['u_deadbeef'] } });
    expect(runGate(wrap([makeUpdate()], [bogusIds])).violations.some((v) => v.includes('does not resolve inside'))).toBe(true);

    const badRef = makeRevision({
      grounded_in: { vehicle_statuses: { 'test-bill-1': 'passed_chamber' }, update_ids: [], refs: ['http://insecure.example'] },
    });
    expect(runGate(wrap([makeUpdate()], [badRef])).violations.some((v) => v.includes('not an https URL'))).toBe(true);

    const ghostVehicle = makeRevision({ grounded_in: { vehicle_statuses: { 'ghost-99': 'committee' }, update_ids: [] } });
    expect(runGate(wrap([makeUpdate()], [ghostVehicle])).violations.some((v) => v.includes('is not one of example-moment'))).toBe(true);
  });

  test('a live moment with zero revisions warns (never fails) — the summary may not have run yet', () => {
    const { violations, warnings } = runGate(wrap([makeUpdate()], []));
    expect(violations).toEqual([]);
    expect(warnings.some((w) => w.includes('zero summary revisions'))).toBe(true);
  });

  test('root shape and _meta are hard failures', () => {
    expect(checkMomentUpdates([] as unknown as Record<string, unknown>, MOMENTS, SLUGS, { now: NOW }).violations[0]).toContain('root must be an object');
    const noMeta = { 'example-moment': { updates: [], summary_revisions: [makeRevision()] } };
    expect(runGate(noMeta).violations.some((v) => v.includes('_meta: missing'))).toBe(true);
    const badSchema = { ...wrap([]), _meta: { schema: 99, generated_at: '2026-07-25T03:00:00Z' } };
    expect(runGate(badSchema).violations.some((v) => v.includes('_meta.schema'))).toBe(true);
  });

  test('duplicate ids inside one moment fail', () => {
    const u = makeUpdate();
    expect(runGate(wrap([u, { ...u }])).violations.some((v) => v.includes('is duplicated inside'))).toBe(true);
  });
});
