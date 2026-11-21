import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkMomentUpdates } from '../lib/moment-updates-gate.mjs';
import {
  RECORD_ONLY_MODEL,
  planSummaries,
  recordOnlyRevision,
  recordOnlyText,
  writeBehindRecordOnlyFallbacks,
  writeSummaries,
} from '../scripts/moment-updates.mjs';
import { fixClock } from './fixed-clock';

/*
 * A RECORD-ONLY SENTENCE NEVER FALLS BEHIND THE RECORD (2026-11-21).
 *
 * The case, as it stood on the site: the penny question's "Where it stands"
 * was the record-only sentence written on 2026-10-16, "The latest action in
 * the official record on these measures is dated October 14, 2026." H.R. 10167
 * was presented to the president on 2026-11-12 and signed on 2026-11-20. The
 * model's rewrite was refused by the lint eight runs in a row (2026-11-13 to
 * 11-20), a refused reply stores nothing, and the October sentence stood
 * while the record it described had moved on.
 *
 * What is real here: the question's id, its three measures, the October
 * sentence and its stamp, the signing date, the refusal counter's shape. What
 * is SYNTHETIC: the last-action dates of S. 1525 and H.R. 3074 (both set
 * earlier than October 14) and the empty update list.
 *
 * No real clock and no live data file: `fixClock` holds `new Date()` at NOW,
 * and every other date is passed in.
 */

const MOMENT = 'penny-production-and-cash-rounding';
const SLUGS = ['hr-10167-119', 's-1525-119', 'hr-3074-119'];
const MOMENTS = { [MOMENT]: { status: 'live', vehicles: SLUGS.map((slug) => ({ slug })) } };
/** The nightly of the ET day 2026-11-20 (22:00 ET). */
const NOW = Date.parse('2026-11-21T03:00:00Z');
fixClock(NOW);

const OCT_STATUSES = { 'hr-10167-119': 'passed_chamber', 's-1525-119': 'passed_chamber', 'hr-3074-119': 'passed_chamber' };
const bills = (hr10167: { status: string; last_action_date: string | null; last_action_text: string }) =>
  new Map<string, Record<string, unknown>>([
    ['hr-10167-119', { full_identifier: 'hr-10167-119', bill_type: 'hr', ...hr10167 }],
    ['s-1525-119', { full_identifier: 's-1525-119', bill_type: 's', status: 'passed_chamber', last_action_date: '2026-06-02', last_action_text: 'Held at the desk.' }],
    ['hr-3074-119', { full_identifier: 'hr-3074-119', bill_type: 'hr', status: 'passed_chamber', last_action_date: '2026-05-19', last_action_text: 'Received in the Senate.' }],
  ]);
const SIGNED = bills({ status: 'signed', last_action_date: '2026-11-20', last_action_text: 'Signed by President.' });

/** The sentence on the page since 2026-10-16, built the way the collector built it. */
const octoberSentence = () =>
  recordOnlyRevision({
    momentId: MOMENT,
    entry: { updates: [], summary_revisions: [] },
    statuses: OCT_STATUSES,
    records: { 'hr-10167-119': { lastActionDate: '2026-10-14' }, 's-1525-119': { lastActionDate: '2026-06-02' }, 'hr-3074-119': { lastActionDate: '2026-05-19' } },
    votes: [],
    rollCallsOnRecord: [],
    day: '2026-10-16',
    generatedAt: '2026-10-16T18:16:51.691Z',
  })!;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Entry = Record<string, any>;
const pennyEntry = (extra: Entry = {}): Entry => ({
  updates: [],
  summary_revisions: [octoberSentence()],
  summary_refusals: { count: 7, day: '2026-11-19', reason: 'en: absence claim "No recorded votes" over a record that is not empty' },
  ...extra,
});
const plan = (entry: Entry, billBySlug = SIGNED, now = NOW) =>
  planSummaries({ mode: 'nightly', moments: MOMENTS, store: { [MOMENT]: entry }, billBySlug, rollCalls: [], floorSignals: null, now, unsupportedStatus: () => false });

/** A model stub: counts calls, then replies with `reply` or throws. */
const model = (reply: string | Error) => {
  const box = { calls: 0 };
  return {
    box,
    client: {
      messages: {
        create: async () => {
          box.calls++;
          if (reply instanceof Error) throw reply;
          return { content: [{ type: 'text', text: reply }] };
        },
      },
    },
  };
};

const NOVEMBER = recordOnlyText('2026-11-20', 3);

test('the fixture is the sentence that stood on the page, and the one that replaces it', () => {
  expect(octoberSentence().text).toEqual({
    en: 'The latest action in the official record on these measures is dated October 14, 2026.',
    es: 'La última acción del registro oficial sobre estas medidas es del 14 de octubre de 2026.',
  });
  expect(octoberSentence().model).toBe(RECORD_ONLY_MODEL);
  expect(NOVEMBER).toEqual({
    en: 'The latest action in the official record on these measures is dated November 20, 2026.',
    es: 'La última acción del registro oficial sobre estas medidas es del 20 de noviembre de 2026.',
  });
});

test('the reply is refused: the old sentence is restated from the record that night, with no second model call', async () => {
  const entry = pennyEntry();
  const store = { [MOMENT]: entry };
  const planned = plan(entry);
  // The record moved (the status changed), so the model is asked.
  expect(planned[0].generate).toBe(true);
  expect(planned[0].recordOnly).toBeUndefined();
  const { box, client } = model('this is not JSON');
  expect(await writeSummaries({ plan: planned, store, moments: MOMENTS, anthropic: client, cap: 8 })).toBe(0);
  expect(box.calls).toBe(1);
  // What used to be the end of the night: refused, counted, October stands.
  expect(entry.summary_refusals.count).toBe(8);
  expect(entry.summary_revisions).toHaveLength(1);

  expect(writeBehindRecordOnlyFallbacks({ plan: planned, store, moments: MOMENTS })).toBe(1);
  expect(box.calls).toBe(1);
  const last = entry.summary_revisions.at(-1);
  expect(entry.summary_revisions).toHaveLength(2);
  expect(last.model).toBe(RECORD_ONLY_MODEL);
  expect(last.text).toEqual(NOVEMBER);
  expect(last.as_of_day).toBe('2026-11-20');
  // Grounded in tonight's statuses, the same object a model revision stores.
  expect(last.grounded_in.vehicle_statuses).toEqual({ ...OCT_STATUSES, 'hr-10167-119': 'signed' });
  expect(last.grounded_in.roll_calls_on_record).toEqual([]);
  // The summary is current again: the streak ends, as it does when the plan
  // itself picks the record-only sentence.
  expect(entry).not.toHaveProperty('summary_refusals');

  // The gate accepts what was stored.
  const { violations } = checkMomentUpdates({ _meta: { schema: 1, generated_at: new Date(NOW).toISOString() }, ...store }, MOMENTS, new Set(SLUGS), { now: NOW });
  expect(violations).toEqual([]);

  // Twice in one night writes once; the next night, with the record where it
  // was, asks no model and writes nothing.
  expect(writeBehindRecordOnlyFallbacks({ plan: planned, store, moments: MOMENTS })).toBe(0);
  const nextNight = plan(entry, SIGNED, NOW + 24 * 3600 * 1000);
  expect(nextNight[0].generate).toBe(false);
  expect(nextNight[0].recordOnly).toBeUndefined();
  const second = model('this is not JSON');
  expect(await writeSummaries({ plan: nextNight, store, moments: MOMENTS, anthropic: second.client, cap: 8 })).toBe(0);
  expect(writeBehindRecordOnlyFallbacks({ plan: nextNight, store, moments: MOMENTS })).toBe(0);
  expect(second.box.calls).toBe(0);
  expect(entry.summary_revisions).toHaveLength(2);
});

test('the call fails, the budget is spent, or there is no key: the sentence is restated all the same', async () => {
  const cases: { name: string; anthropic: unknown; cap: number }[] = [
    { name: 'the call throws', anthropic: model(new Error('model down')).client, cap: 8 },
    { name: 'the budget is spent', anthropic: model('unused').client, cap: 0 },
    { name: 'no key', anthropic: null, cap: 8 },
  ];
  for (const c of cases) {
    const entry = pennyEntry();
    const store = { [MOMENT]: entry };
    const planned = plan(entry);
    expect(await writeSummaries({ plan: planned, store, moments: MOMENTS, anthropic: c.anthropic, cap: c.cap }), c.name).toBe(0);
    expect(entry.summary_revisions.at(-1).text, c.name).toEqual(octoberSentence().text);
    expect(writeBehindRecordOnlyFallbacks({ plan: planned, store, moments: MOMENTS }), c.name).toBe(1);
    expect(entry.summary_revisions.at(-1).text, c.name).toEqual(NOVEMBER);
    expect(entry.summary_revisions.at(-1).model, c.name).toBe(RECORD_ONLY_MODEL);
  }
});

test('a model-written summary is never replaced here: the previous revision stands, and the refusal is still counted', async () => {
  const written = { ...octoberSentence(), id: 's_0a1b2c3d', model: 'claude-sonnet-5', text: { en: 'Prior.', es: 'Previo.' } };
  const entry = pennyEntry({ summary_revisions: [written] });
  const store = { [MOMENT]: entry };
  const planned = plan(entry);
  expect(planned[0].generate).toBe(true);
  await writeSummaries({ plan: planned, store, moments: MOMENTS, anthropic: model('this is not JSON').client, cap: 8 });
  expect(writeBehindRecordOnlyFallbacks({ plan: planned, store, moments: MOMENTS })).toBe(0);
  expect(entry.summary_revisions).toEqual([written]);
  expect(entry.summary_refusals.count).toBe(8);
});

test('a sentence that already says what the record says is left alone, and so is the refusal counter', () => {
  // The record has not moved since October: same statuses, same latest date.
  const still = bills({ status: 'passed_chamber', last_action_date: '2026-10-14', last_action_text: 'Received in the Senate.' });
  const entry = pennyEntry();
  const store = { [MOMENT]: entry };
  const planned = plan(entry, still);
  expect(writeBehindRecordOnlyFallbacks({ plan: planned, store, moments: MOMENTS })).toBe(0);
  expect(entry.summary_revisions).toHaveLength(1);
  expect(entry.summary_refusals.count).toBe(7);
});

test('no dated action on any measure tonight: nothing true to restate it with, so nothing is written', () => {
  const undated = new Map<string, Record<string, unknown>>(SLUGS.map((slug) => [slug, { full_identifier: slug, status: slug === 'hr-10167-119' ? 'signed' : 'passed_chamber', last_action_date: null, last_action_text: null }]));
  const entry = pennyEntry();
  const store = { [MOMENT]: entry };
  expect(writeBehindRecordOnlyFallbacks({ plan: plan(entry, undated), store, moments: MOMENTS })).toBe(0);
  expect(entry.summary_revisions).toHaveLength(1);
  expect(entry.summary_refusals.count).toBe(7);
});

test('a question with no entry, or no revision yet, is skipped without a throw', () => {
  expect(writeBehindRecordOnlyFallbacks({ plan: [{ momentId: 'not-in-the-store' }], store: {}, moments: MOMENTS })).toBe(0);
  const entry: Entry = { updates: [], summary_revisions: [] };
  expect(writeBehindRecordOnlyFallbacks({ plan: plan(entry), store: { [MOMENT]: entry }, moments: MOMENTS })).toBe(0);
  expect(entry.summary_revisions).toEqual([]);
});

test('main() runs it every run, after writeSummaries and the re-check fallback', () => {
  const src = readFileSync(join(process.cwd(), 'scripts/moment-updates.mjs'), 'utf8');
  const body = src.slice(src.indexOf('async function main()'));
  expect(body).toMatch(
    /await writeSummaries\(\{[^}]*\}\);[\s\S]{0,700}?const fallbacks = writeStaleRecheckFallbacks\(\{ plan, store, moments \}\);[\s\S]{0,500}?const restated = writeBehindRecordOnlyFallbacks\(\{ plan, store, moments \}\);/,
  );
});
