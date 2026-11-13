import { expect, test } from '@playwright/test';
/*
 * ONE EVENT, ONE ROW — across runs (2026-11-13).
 *
 * The hourly run stored H.R. 10167's "Presented to President." as a
 * floor_action at 16:15Z (u_cbb3a86d). The nightly bill sync at 21:27Z saw
 * data/bills.json's last action move to the same words and stored a
 * status_change for it (u_cf968af1). The in-run suppression
 * (suppressRedundantStatusChanges) only compares candidates of one run, and
 * the two rows differ in class, so nothing folded them: the penny question's
 * Nov 12 printed the same sentence twice, in both languages, and
 * tests/moment-updates-page.spec.ts failed strict mode on it.
 *
 * Each layer of the fix is pinned here: the rule itself, the prune that heals
 * a stored repeat (and carries its citations), the collector that no longer
 * collects one, and the pre-commit check that refuses a file still holding
 * one. Pure: no network, no model calls; the last test reads the committed
 * file only to show the heal on the real row while it is still there.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkMomentUpdates, collapseRedundantStatusChanges, pruneEntry } from '../lib/moment-updates-gate.mjs';
import { verifyMomentUpdates } from '../lib/verify-moment-updates.mjs';
import { statusDiffToCandidate } from '../scripts/moment-updates-map.mjs';
import { survivingCandidates } from '../scripts/moment-updates.mjs';

const MOMENT = 'penny-production-and-cash-rounding';
const VEHICLE = 'hr-10167-119';
const NOW = Date.parse('2026-11-13T22:00:00Z');
const TEXT = {
  en: 'H.R. 10167 was presented to the president on November 12, 2026.',
  es: 'H.R. 10167 fue presentado al presidente el 12 de noviembre de 2026.',
};
const SOURCE = { kind: 'congress_actions', refs: ['https://www.congress.gov/bill/119th-congress/house-bill/10167'] };

/** The two rows as the store held them on 2026-11-13, verbatim. */
const FLOOR = {
  id: 'u_cbb3a86d',
  class: 'floor_action',
  vehicle: VEHICLE,
  day: '2026-11-12',
  occurred_at: '2026-11-12',
  occurred_precision: 'day',
  recorded_at: '2026-11-13T16:15:42.959Z',
  text: TEXT,
  source: SOURCE,
  record: { action_text: 'Presented to President.', action_code: 'E20000', action_type: 'Floor', source_system: 'House floor actions' },
  ai: true,
};
const STATUS = {
  id: 'u_cf968af1',
  class: 'status_change',
  vehicle: VEHICLE,
  day: '2026-11-12',
  occurred_at: '2026-11-12',
  occurred_precision: 'day',
  recorded_at: '2026-11-13T21:27:01.988Z',
  text: TEXT,
  source: SOURCE,
  record: {
    action_text: 'Presented to President.',
    action_code: null,
    action_type: 'latestAction',
    source_system: 'Congress.gov bill detail',
    status_from: 'passed_chamber',
    status_to: 'passed_chamber',
  },
  ai: true,
};

test.describe('collapseRedundantStatusChanges', () => {
  test('folds the 2026-11-13 status_change into the floor action that carries the same record', () => {
    const { kept, remap } = collapseRedundantStatusChanges([STATUS, FLOOR]);
    expect(kept.map((u) => u.id)).toEqual(['u_cbb3a86d']);
    expect([...remap]).toEqual([['u_cf968af1', 'u_cbb3a86d']]);
  });

  test('a trailing Congressional Record citation does not make a repeat look new', () => {
    const cited = { ...STATUS, record: { ...STATUS.record, action_text: 'Presented to President. (CR H1234)' } };
    expect(collapseRedundantStatusChanges([cited, FLOOR]).kept).toEqual([FLOOR]);
  });

  test('keeps the status_change when the record says something else, on another day, or on another vehicle', () => {
    const otherText = { ...STATUS, record: { ...STATUS.record, action_text: 'Signed by President.' } };
    const otherDay = { ...STATUS, day: '2026-11-13' };
    const otherVehicle = { ...STATUS, vehicle: 'hr-1-119' };
    for (const row of [otherText, otherDay, otherVehicle]) {
      expect(collapseRedundantStatusChanges([row, FLOOR]).kept).toEqual([row, FLOOR]);
    }
  });

  test('never drops the richer row, and two status changes alone are left to the other collapses', () => {
    expect(collapseRedundantStatusChanges([FLOOR]).kept).toEqual([FLOOR]);
    const twin = { ...STATUS, id: 'u_00000001' };
    expect(collapseRedundantStatusChanges([STATUS, twin]).kept).toEqual([STATUS, twin]);
  });
});

test.describe('the prune heals a stored repeat on the next run', () => {
  test('drops the repeat and carries a summary citation of it to the row that stands for it', () => {
    const entry = {
      updates: [STATUS, FLOOR],
      summary_revisions: [{ id: 's_1', grounded_in: { vehicle_statuses: {}, update_ids: ['u_cf968af1', 'u_cbb3a86d'] } }],
    };
    const pruned = pruneEntry(entry, { now: NOW })!;
    expect(pruned.updates.map((u: { id: string }) => u.id)).toEqual(['u_cbb3a86d']);
    expect(pruned.summary_revisions[0].grounded_in.update_ids).toEqual(['u_cbb3a86d']);
  });

  test('a correction of the repeat now names the surviving row', () => {
    const correction = { ...FLOOR, id: 'u_c0000001', class: 'correction', corrects: 'u_cf968af1', record: { ...FLOOR.record, action_text: 'Correction.' } };
    const pruned = pruneEntry({ updates: [STATUS, FLOOR, correction], summary_revisions: [] }, { now: NOW })!;
    const kept = pruned.updates.find((u: { id: string }) => u.id === 'u_c0000001');
    expect(kept.corrects).toBe('u_cbb3a86d');
  });
});

test('the nightly no longer collects a status_change the hourly run already stored as an action', () => {
  const candidate = statusDiffToCandidate({
    momentId: MOMENT,
    vehicle: VEHICLE,
    before: { status: 'passed_chamber', last_action_date: '2026-10-14', last_action_text: 'Message on Senate action sent to the House.' },
    after: { status: 'passed_chamber', last_action_date: '2026-11-12', last_action_text: 'Presented to President.' },
    recordedAt: '2026-11-13T21:27:01.988Z',
  });
  expect(candidate, 'a presentment is a milestone, so the diff does produce a candidate').not.toBeNull();
  const store = { [MOMENT]: { updates: [FLOOR], summary_revisions: [] } };
  const { kept, dropped } = survivingCandidates([{ ...candidate, __moment: MOMENT }], store, NOW);
  expect(kept).toEqual([]);
  expect(dropped.map((c) => c.class)).toEqual(['status_change']);
});

test.describe('the pre-commit check refuses a file that still holds a repeat', () => {
  const file = (updates: unknown[]) => ({
    _meta: { schema: 1, generated_at: '2026-11-13T21:27:01.988Z' },
    [MOMENT]: { updates, summary_revisions: [] },
  });

  test('fails with the repeat named, and passes once the prune has run', () => {
    const { failures } = verifyMomentUpdates({ updates: file([STATUS, FLOOR]), now: NOW });
    expect(failures.join('\n')).toContain(`${MOMENT}/u_cf968af1 repeats u_cbb3a86d`);
    const healed = pruneEntry({ updates: [STATUS, FLOOR], summary_revisions: [] }, { now: NOW })!;
    expect(verifyMomentUpdates({ updates: file(healed.updates), now: NOW }).failures).toEqual([]);
  });
});

test('the committed file: the prune folds exactly the 2026-11-13 repeat and the CI gate stays clean', () => {
  const real = JSON.parse(readFileSync(join(process.cwd(), 'data/moment-updates.json'), 'utf8'));
  const entry = real[MOMENT];
  const present = (entry?.updates ?? []).some((u: { id: string }) => u.id === 'u_cf968af1');
  // The collector heals the file on its first run with this code; the pin is
  // only meaningful while the repeat is still in the committed file.
  test.skip(!present, 'the committed file no longer carries u_cf968af1');
  const now = Date.now();
  const pruned = pruneEntry(entry, { now })!;
  expect(pruned.updates.some((u: { id: string }) => u.id === 'u_cf968af1')).toBe(false);
  expect(pruned.updates.some((u: { id: string }) => u.id === 'u_cbb3a86d')).toBe(true);
  // Nothing else moves: the same prune over the file without the repeat
  // (retention still applies to both) keeps the same rows.
  const without = { ...entry, updates: entry.updates.filter((u: { id: string }) => u.id !== 'u_cf968af1') };
  expect(pruned.updates).toEqual(pruneEntry(without, { now })!.updates);

  const moments = JSON.parse(readFileSync(join(process.cwd(), 'data/moments.json'), 'utf8'));
  const bills: { full_identifier: string }[] = JSON.parse(readFileSync(join(process.cwd(), 'data/bills.json'), 'utf8'));
  const next = { ...real, [MOMENT]: pruned };
  const { violations } = checkMomentUpdates(next, moments, new Set(bills.map((b) => b.full_identifier)));
  expect(violations).toEqual([]);
});
