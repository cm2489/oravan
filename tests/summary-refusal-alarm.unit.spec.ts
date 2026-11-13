import { expect, test } from '@playwright/test';
/*
 * THE REFUSAL ALARM (2026-11-12). A refused "Where it stands" reply stores
 * nothing and the previous revision stands; nothing retries it. Until this,
 * the only trace was one console line per run, so a summary refused night
 * after night sat stale with no alarm. Now the collector counts refused
 * replies in a row per question (`summary_refusals` in
 * data/moment-updates.json, beside `summary_attempts`), prints a GitHub
 * Actions ::warning:: from the SUMMARY_REFUSAL_ALARM_RUNS-th on, and the
 * pipeline health report raises `summary-refused` from the committed counter.
 *
 * ZERO network and ZERO model calls: the Anthropic clients are stubs. No
 * committed data/ file is read; the roll call and the summaries are copied
 * from tests/moment-updates-live-votes.unit.spec.ts (roll 244, the Senate's
 * vote on H.Con.Res. 89, 2026-09-24).
 */
import {
  checkMomentUpdates,
  nextSummaryRefusals,
  SUMMARY_REFUSAL_ALARM_RUNS,
  SUMMARY_REFUSAL_REASON_MAX,
  summaryRefusalWarning,
} from '../lib/moment-updates-gate.mjs';
import { verifyMomentUpdates } from '../lib/verify-moment-updates.mjs';
import { alarms, refusedSummaries } from '../lib/pipeline-health.mjs';
import { INTRADAY_SUMMARY_CAP, writeSummaries } from '../scripts/moment-updates.mjs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const ROLL_244 = {
  id: 's-119-2-244', chamber: 'senate', congress: 119, session: 2, roll: 244, date: '2026-09-24',
  question: 'On the Concurrent Resolution H.Con.Res. 89', result: 'Concurrent Resolution Rejected', bill: 'hconres-89-119',
  totals: { yea: 49, nay: 50, present: 0, notVoting: 1 },
};
const IRAN_VEHICLES = ['sjres-185-119', 'sjres-172-119', 'hconres-38-119', 'hconres-89-119'];
const IRAN_STATUSES = {
  'sjres-185-119': 'floor_vote',
  'sjres-172-119': 'floor_vote',
  'hconres-38-119': 'floor_vote',
  'hconres-89-119': 'passed_chamber',
};
const MOMENTS = { 'iran-war-powers': { status: 'live', vehicles: IRAN_VEHICLES.map((slug) => ({ slug })) } };

/** Refused by the absence lint: the window holds roll 244. */
const REFUSED = { en: 'No new votes were recorded.', es: 'No se registraron nuevas votaciones.' };
/** States the record; stored. */
const GROUNDED = {
  en: 'On September 24, 2026, the Senate rejected H. Con. Res. 89 by a recorded vote of 49 to 50 (Roll no. 244). S.J.Res. 185 and S.J.Res. 172 show floor activity, and H. Con. Res. 38 shows floor activity.',
  es: 'El 24 de septiembre de 2026, el Senado rechazó H. Con. Res. 89 por votación nominal de 49 a 50 (votación núm. 244). S.J.Res. 185 y S.J.Res. 172 muestran actividad en el pleno, y H. Con. Res. 38 también.',
};

const replying = (reply: unknown) => ({
  messages: { create: async () => ({ content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }] }) },
});
const throwing = {
  messages: {
    create: async () => {
      throw new Error('overloaded');
    },
  },
};
const generating = (day: string) => ({
  momentId: 'iran-war-powers',
  generate: true,
  reason: 'test',
  statuses: IRAN_STATUSES,
  records: {},
  votes: [ROLL_244],
  intraday: false,
  day,
});

/** Runs `fn` with console.log captured; returns what it printed. */
async function printed(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}
const warnings = (lines: string[]) => lines.filter((l) => l.startsWith('::warning::'));

test.describe('the counter and the warning line', () => {
  test('the threshold is 3: the intraday cap, a whole ET day of calls for one question', () => {
    expect(SUMMARY_REFUSAL_ALARM_RUNS).toBe(3);
    expect(SUMMARY_REFUSAL_ALARM_RUNS).toBe(INTRADAY_SUMMARY_CAP);
  });

  test('each refused reply adds one; the reason is one line, cut to its maximum', () => {
    const one = nextSummaryRefusals({}, '2026-11-10', 'en: absence claim "no new votes"\n over a record that is not empty');
    expect(one).toEqual({ count: 1, day: '2026-11-10', reason: 'en: absence claim "no new votes" over a record that is not empty' });
    const two = nextSummaryRefusals({ summary_refusals: one }, '2026-11-11', 'x'.repeat(1000));
    expect(two.count).toBe(2);
    expect(two.day).toBe('2026-11-11');
    expect(two.reason).toHaveLength(SUMMARY_REFUSAL_REASON_MAX);
    // A malformed counter starts over rather than inventing a count.
    expect(nextSummaryRefusals({ summary_refusals: { count: 'many' } }, '2026-11-11', 'r').count).toBe(1);
  });

  test('no warning below the threshold; from it on, one line naming the question and the reason, escaped for Actions', () => {
    expect(summaryRefusalWarning('iran-war-powers', { count: 2, day: '2026-11-11', reason: 'r' })).toBeNull();
    const line = summaryRefusalWarning('iran-war-powers', { count: 3, day: '2026-11-12', reason: '100% refused' });
    expect(line).toBe(
      '::warning::moment-updates: the "Where it stands" summary of iran-war-powers was refused on 3 runs in a row (the newest on 2026-11-12 ET); the previous revision stands. Newest reason: 100%25 refused',
    );
    expect(summaryRefusalWarning('iran-war-powers', { count: 7, day: '2026-11-12', reason: 'r' })).toContain('7 runs in a row');
  });
});

test.describe('writeSummaries counts refused replies and clears the count on a stored one', () => {
  test('three refused runs in a row → a ::warning:: on the third, naming the question and the reason; the previous revision stands', async () => {
    const previous = { id: 's_00000001', text: { en: 'Prior.', es: 'Previo.' } };
    const store: Record<string, Json> = { 'iran-war-powers': { updates: [], summary_revisions: [previous] } };
    const days = ['2026-11-10', '2026-11-11', '2026-11-12'];
    const seen: string[][] = [];
    for (const day of days) {
      seen.push(warnings(await printed(() => writeSummaries({ plan: [generating(day)], store, moments: MOMENTS, anthropic: replying(REFUSED) }))));
    }
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual([]);
    expect(seen[2]).toHaveLength(1);
    expect(seen[2][0]).toContain('iran-war-powers');
    expect(seen[2][0]).toContain('3 runs in a row');
    expect(seen[2][0]).toContain('absence claim');
    const entry = store['iran-war-powers'];
    expect(entry.summary_refusals.count).toBe(3);
    expect(entry.summary_refusals.day).toBe('2026-11-12');
    expect(entry.summary_refusals.reason).toContain('absence claim');
    expect(entry.summary_revisions).toEqual([previous]);
    // A fourth refusal warns again: the alarm stays up while it lasts.
    const fourth = warnings(await printed(() => writeSummaries({ plan: [generating('2026-11-13')], store, moments: MOMENTS, anthropic: replying(REFUSED) })));
    expect(fourth[0]).toContain('4 runs in a row');
  });

  test('a reply that is not JSON counts as a refusal', async () => {
    const store: Record<string, Json> = { 'iran-war-powers': { updates: [], summary_revisions: [] } };
    await printed(() => writeSummaries({ plan: [generating('2026-11-12')], store, moments: MOMENTS, anthropic: replying('not json') }));
    expect(store['iran-war-powers'].summary_refusals).toMatchObject({ count: 1, reason: expect.stringContaining('not JSON') });
  });

  test('a call that fails before any reply is not a refusal: the count stays as it was', async () => {
    const counter = { count: 2, day: '2026-11-11', reason: 'en: absence claim' };
    const store: Record<string, Json> = { 'iran-war-powers': { updates: [], summary_revisions: [], summary_refusals: { ...counter } } };
    const original = console.error;
    console.error = () => {};
    try {
      await printed(() => writeSummaries({ plan: [generating('2026-11-12')], store, moments: MOMENTS, anthropic: throwing }));
    } finally {
      console.error = original;
    }
    expect(store['iran-war-powers'].summary_refusals).toEqual(counter);
  });

  test('a stored revision clears the count', async () => {
    const store: Record<string, Json> = {
      'iran-war-powers': { updates: [], summary_revisions: [], summary_refusals: { count: 5, day: '2026-11-11', reason: 'r' } },
    };
    const written = await (async () => {
      let n = 0;
      await printed(async () => {
        n = await writeSummaries({ plan: [generating('2026-11-12')], store, moments: MOMENTS, anthropic: replying(GROUNDED) });
      });
      return n;
    })();
    expect(written).toBe(1);
    expect(store['iran-war-powers']).not.toHaveProperty('summary_refusals');
  });
});

test.describe('the committed field passes the gates', () => {
  const NOW = Date.parse('2026-11-12T20:00:00Z');
  const file = (refusals: unknown) => ({
    _meta: { schema: 1, generated_at: '2026-11-12T20:00:00Z' },
    'iran-war-powers': { updates: [], summary_revisions: [], summary_refusals: refusals },
  });
  const gate = (refusals: unknown) => checkMomentUpdates(file(refusals), MOMENTS, new Set(IRAN_VEHICLES), { now: NOW }).violations;

  test('check-moment-updates accepts a well-formed counter and rejects a malformed or future one', () => {
    expect(gate({ count: 3, day: '2026-11-12', reason: 'en: absence claim' })).toEqual([]);
    expect(gate({ count: 0, day: '2026-11-12', reason: 'r' })).toHaveLength(1);
    expect(gate({ count: 1, day: 'today', reason: 'r' })).toHaveLength(1);
    expect(gate({ count: 1, day: '2026-11-12', reason: '' })).toHaveLength(1);
    expect(gate({ count: 1, day: '2026-11-12', reason: 'x'.repeat(SUMMARY_REFUSAL_REASON_MAX + 1) })).toHaveLength(1);
    expect(gate({ count: 1, day: '2026-11-20', reason: 'r' }).some((v: string) => v.includes('future'))).toBe(true);
  });

  test('verify-sync (verifyMomentUpdates) does not fail on it', () => {
    const { failures } = verifyMomentUpdates({ updates: file({ count: 3, day: '2026-11-12', reason: 'r' }), moments: MOMENTS, now: NOW });
    expect(failures).toEqual([]);
  });
});

test.describe('the pipeline health report reads the committed counter', () => {
  const FILE = {
    _meta: { schema: 1 },
    'iran-war-powers': { summary_refusals: { count: 3, day: '2026-11-12', reason: 'en: absence claim' } },
    'paying-college-athletes': { summary_refusals: { count: 2, day: '2026-11-12', reason: 'r' } },
    'retired-question': { summary_refusals: { count: 9, day: '2026-10-01', reason: 'r' } },
  };

  test('only questions at the threshold or past it, and only live ones when the live list is known', () => {
    expect(refusedSummaries(FILE)!.map((r) => r.id)).toEqual(['retired-question', 'iran-war-powers']);
    expect(refusedSummaries(FILE, { liveIds: ['iran-war-powers', 'paying-college-athletes'] })).toEqual([
      { id: 'iran-war-powers', count: 3, day: '2026-11-12', reason: 'en: absence claim' },
    ]);
    // Not read is not "none".
    expect(refusedSummaries(null)).toBeNull();
  });

  test('a summary-refused alarm names each question; none when nothing is past the threshold', () => {
    const healthy = { nightly: { conclusion: 'success' } };
    const raised = alarms({ ...healthy, summaryRefusals: refusedSummaries(FILE, { liveIds: ['iran-war-powers'] }) });
    const refused = raised.filter((a: { code: string }) => a.code === 'summary-refused');
    expect(refused).toHaveLength(1);
    expect(refused[0].text).toContain('iran-war-powers (3 in a row, newest 2026-11-12 ET: en: absence claim)');
    expect(alarms({ ...healthy, summaryRefusals: [] }).some((a: { code: string }) => a.code === 'summary-refused')).toBe(false);
    expect(alarms({ ...healthy, summaryRefusals: null }).some((a: { code: string }) => a.code === 'summary-refused')).toBe(false);
  });
});
