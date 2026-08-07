import { expect, test } from '@playwright/test';
// The collector's SAFETY BRANCHES — the places where a failure is supposed to
// degrade to a safe state rather than publish something the constitution
// forbids. Until 2026-08-06 none of them had a test, for one structural
// reason: scripts/moment-updates.mjs ran its whole pipeline at module scope,
// so merely importing it opened data/, shelled out to git, fetched
// Congress.gov, and constructed an Anthropic client (the exclusion is recorded
// at the top of tests/moment-updates-collect.unit.spec.ts). That file now
// wraps its run in main() behind a run-directly guard, and every module-scope
// read moved inside it, so a bare import does nothing at all.
//
// ZERO network and ZERO filesystem in this file: the Anthropic client is
// injected, and the write sink is a recorder. Deliberately NOT covered — the
// daily-event ceiling and the batch cap. Those are Math.max/slice arithmetic
// whose failure mode is "fewer events tonight, the rest tomorrow": bounded,
// self-correcting, and already printed in the run log. A test there could not
// catch anything a reader would ever see.
import {
  assignUpdateText,
  decodeUpdates,
  generateStateSummary,
  lintPair,
  writeIfChanged,
} from '../scripts/moment-updates.mjs';
import { actionToCandidate, fallbackTextFor } from '../scripts/moment-updates-map.mjs';
import { SCHEMA_VERSION } from '../lib/moment-updates-gate.mjs';

/* ------------------------------------------------------------------ *
 * Fixtures — literals in the shape the Congress.gov actions endpoint
 * really returns (the same shape tests/fixtures/congress-actions-*.json
 * captured from live), never a fetch.
 * ------------------------------------------------------------------ */

const BILL_URL = 'https://www.congress.gov/bill/119th-congress/house-bill/9770';

function voteCandidate(over: Record<string, unknown> = {}) {
  const action = {
    actionDate: '2026-07-24',
    text: 'Passed/agreed to in House: On passage Passed by the Yeas and Nays: 220 - 205 (Roll no. 272).',
    actionCode: '8000',
    type: 'Floor',
    sourceSystem: { name: 'Library of Congress' },
    recordedVotes: [{ chamber: 'House', rollNumber: 272, url: 'https://clerk.house.gov/evs/2026/roll272.xml' }],
    ...over,
  };
  return actionToCandidate({
    momentId: 'test-moment',
    vehicle: 'hr-9770-119',
    action,
    billUrl: BILL_URL,
    recordedAt: '2026-07-25T02:00:00Z',
  });
}

/** An Anthropic-shaped stub. `reply` is the assistant's raw text. */
const clientReturning = (reply: string) => ({
  messages: { create: async () => ({ content: [{ type: 'text', text: reply }] }) },
});

const throwingClient = {
  messages: {
    create: async () => {
      throw new Error('boom');
    },
  },
};

/* ------------------------------------------------------------------ *
 * 1 · decodeUpdates — every exit degrades to the verbatim record.
 *
 * An empty Map is not "no result": assignUpdateText reads it as "no line
 * returned" and stores the government's own sentence with ai:false. So the
 * promise these three tests pin is that an outage, a chatty model, or a
 * hallucinated index can only ever cost us the DECODE, never the update, and
 * never the truth of what is stored.
 * ------------------------------------------------------------------ */
test.describe('decodeUpdates', () => {
  test('an API outage returns an empty Map — the nightly degrades, it never throws', async () => {
    const decoded = await decodeUpdates(throwingClient, [voteCandidate()]);
    expect(decoded.size).toBe(0);
  });

  test('a non-JSON reply returns an empty Map', async () => {
    const decoded = await decodeUpdates(clientReturning('Sure! Here are the lines you asked for.'), [voteCandidate()]);
    expect(decoded.size).toBe(0);
  });

  test('a fenced JSON reply is still parsed — the strip is real logic, not decoration', async () => {
    const fenced = '```json\n[{"i":0,"en":"The House passed the bill, 220-205.","es":"La Cámara aprobó el proyecto, 220-205."}]\n```';
    const decoded = await decodeUpdates(clientReturning(fenced), [voteCandidate()]);
    expect(decoded.size).toBe(1);
    expect(decoded.get(0).en).toBe('The House passed the bill, 220-205.');
  });

  test('an index the batch never offered is refused — a hallucinated row cannot enter the Map', async () => {
    const batch = [voteCandidate(), voteCandidate({ actionDate: '2026-07-23' })];
    const reply = JSON.stringify([
      { i: 0, en: 'The House passed the bill, 220-205.', es: 'La Cámara aprobó el proyecto, 220-205.' },
      { i: 99, en: 'The Senate confirmed the nominee.', es: 'El Senado confirmó al nominado.' },
    ]);
    const decoded = await decodeUpdates(clientReturning(reply), batch);
    expect([...decoded.keys()]).toEqual([0]);
    expect(decoded.has(99)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · The lint and its consequence — the highest-value pin in this file.
 *
 * A hedged line is not repaired and gets no second attempt. Rejecting it is
 * only half the promise; the other half is what takes its place, and that is
 * what actually keeps a forecast out of Oravan's voice. Forecasts have reached
 * production prose here twice ("heading to a vote" over a timeline of rejected
 * motions, and a leaked `floor_vote` enum), which is why the consequence is
 * asserted and not just the verdict.
 * ------------------------------------------------------------------ */
test.describe('a hedged decode falls back to the record', () => {
  test('lintPair rejects a forecast on a record class, in either language', () => {
    expect(
      lintPair(
        { en: 'The Senate is expected to vote on the measure next week.', es: 'El Senado votará la medida.' },
        'vote',
        [],
      ).some((f: string) => f.startsWith('en:') && f.includes('speculation')),
    ).toBe(true);

    expect(
      lintPair(
        { en: 'The Senate voted on the measure.', es: 'Se espera que el Senado vote la medida.' },
        'vote',
        [],
      ).some((f: string) => f.startsWith('es:') && f.includes('speculation')),
    ).toBe(true);
  });

  test('and the consequence holds: ai:false, and the text IS the verbatim record', () => {
    const c = voteCandidate();
    const decoded = new Map([
      [0, { en: 'The House is expected to pass the bill next week.', es: 'Se espera que la Cámara apruebe el proyecto.' }],
    ]);

    const { aiCount, fallbackCount } = assignUpdateText([c], [], decoded);

    expect(aiCount).toBe(0);
    expect(fallbackCount).toBe(1);
    expect(c.ai).toBe(false);
    expect(c.text).toEqual(fallbackTextFor(c));
    // Belt and braces on the thing that matters: the model's sentence is gone.
    expect(c.text.en).not.toContain('expected to');
  });

  test('a clean line is accepted and labelled ai:true — the gate is not a blanket refusal', () => {
    const c = voteCandidate();
    const decoded = new Map([
      [0, { en: 'The House passed the bill by a recorded vote of 220 to 205 (Roll no. 272).', es: 'La Cámara aprobó el proyecto por votación nominal de 220 a 205 (votación núm. 272).' }],
    ]);

    const { aiCount, fallbackCount } = assignUpdateText([c], [], decoded);

    expect(aiCount).toBe(1);
    expect(fallbackCount).toBe(0);
    expect(c.ai).toBe(true);
    expect(c.text.en).toContain('220 to 205');
  });
});

/* ------------------------------------------------------------------ *
 * 3 · generateStateSummary — there is no fallback for a summary.
 *
 * A "where it stands" paragraph is Oravan's own voice, and no government
 * sentence can stand in for it. So a rejected summary returns null and the
 * PREVIOUS revision stands — still honest, because it is still grounded in a
 * record nothing has contradicted. That doctrine was a comment with nothing
 * behind it until this test.
 *
 * `floor_vote` is not an arbitrary status here: it is the one status the
 * function rewrites from its own RECORD_ONLY_PHRASE table, so this test never
 * reaches the lazy messages/*.json read and stays filesystem-free.
 * ------------------------------------------------------------------ */
test.describe('generateStateSummary', () => {
  const STATUSES = { 'hr-9770-119': 'floor_vote' };

  test('a hedged summary is refused, and the previous revision is left untouched', async () => {
    const previous = { id: 's_00000001', text: { en: 'Prior.', es: 'Previo.' } };
    const entry = { updates: [], summary_revisions: [previous] };
    const hedged = JSON.stringify({
      en: 'The measure is expected to reach the floor next week.',
      es: 'Se espera que la medida llegue al pleno la próxima semana.',
    });

    const revision = await generateStateSummary(clientReturning(hedged), 'test-moment', entry, STATUSES, []);

    expect(revision).toBeNull();
    // The caller appends only when a revision comes back, so "the previous
    // revision stands" is exactly this: nothing was added, nothing replaced.
    expect(entry.summary_revisions).toEqual([previous]);
  });

  test('an API outage returns null rather than throwing out of the nightly', async () => {
    const entry = { updates: [], summary_revisions: [] };
    expect(await generateStateSummary(throwingClient, 'test-moment', entry, STATUSES, [])).toBeNull();
  });

  test('a reply with no EN/ES pair returns null — bilingual parity has no machine exemption', async () => {
    const entry = { updates: [], summary_revisions: [] };
    const enOnly = JSON.stringify({ en: 'The House passed the bill on July 24, 2026.' });
    expect(await generateStateSummary(clientReturning(enOnly), 'test-moment', entry, STATUSES, [])).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 4 · writeIfChanged — "a news pipeline or a deploy storm".
 *
 * Its own comment says so, and it runs 24x a day. A restamp alone produces a
 * commit, a deploy, and a rebuild every hour forever, for no content
 * whatsoever. The sink is injected so this can assert the only thing that
 * really matters — that a no-op writes NOTHING — without letting the test
 * overwrite the repo's real data file.
 * ------------------------------------------------------------------ */
test.describe('writeIfChanged', () => {
  const PRIOR_STAMP = '2026-07-25T03:00:00Z';
  const shaped = (stamp: string, next: Record<string, unknown>) =>
    `${JSON.stringify({ _meta: { schema: SCHEMA_VERSION, generated_at: stamp }, ...next }, null, 2)}\n`;

  const entries = { 'test-moment': { updates: [], summary_revisions: [] } };

  test('identical content: returns false, writes nothing, and does NOT restamp', () => {
    const wrote: [string, string][] = [];
    const previousText = shaped(PRIOR_STAMP, entries);

    const changed = writeIfChanged(entries, previousText, {
      path: 'scratch/moment-updates.json',
      sink: (p: string, text: string) => {
        wrote.push([p, text]);
      },
    });

    expect(changed).toBe(false);
    expect(wrote).toEqual([]);
    // The stamp on disk is still the old one, because nothing was written.
    expect(JSON.parse(previousText)._meta.generated_at).toBe(PRIOR_STAMP);
  });

  test('changed content: returns true and writes with a NEW stamp', () => {
    const wrote: [string, string][] = [];
    const previousText = shaped(PRIOR_STAMP, entries);
    const next = { ...entries, 'second-moment': { updates: [], summary_revisions: [] } };

    const changed = writeIfChanged(next, previousText, {
      path: 'scratch/moment-updates.json',
      sink: (p: string, text: string) => {
        wrote.push([p, text]);
      },
    });

    expect(changed).toBe(true);
    expect(wrote).toHaveLength(1);
    expect(wrote[0][0]).toBe('scratch/moment-updates.json');

    const written = JSON.parse(wrote[0][1]);
    expect(written._meta.schema).toBe(SCHEMA_VERSION);
    expect(written._meta.generated_at).not.toBe(PRIOR_STAMP);
    expect(Number.isFinite(Date.parse(written._meta.generated_at))).toBe(true);
    expect(written['second-moment']).toBeTruthy();
  });

  test('no previous file at all is a write, not a no-op', () => {
    const wrote: [string, string][] = [];
    const changed = writeIfChanged(entries, null, {
      path: 'scratch/moment-updates.json',
      sink: (p: string, text: string) => {
        wrote.push([p, text]);
      },
    });
    expect(changed).toBe(true);
    expect(wrote).toHaveLength(1);
  });
});
