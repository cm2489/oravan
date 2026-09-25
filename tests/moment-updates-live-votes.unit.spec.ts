import { expect, test } from '@playwright/test';
/*
 * PHASE 0 OF THE REAL-TIME PLAN (2026-09-25): the live layer stops publishing
 * false "nothing happened" claims.
 *
 * THE FAILURE, as recorded in data/moment-updates.json on 2026-09-24:
 *   - iran-war-powers, revision s_088cc923, generated 18:57:01Z by
 *     claude-sonnet-5: "No new votes, tallies, or roll-call numbers have been
 *     recorded … the current standing unchanged" — after the Senate had
 *     rejected H.Con.Res. 89, 49-50 (Senate roll call 244; senate.gov's
 *     vote_date is "September 24, 2026, 01:45 PM", i.e. 17:45Z).
 *   - paying-college-athletes, revision s_e5e3446b, 18:57:12Z: written without
 *     Senate rolls 240/242/243 on S. 4668, which data/votes.json already held
 *     (its _meta.updatedAt was 18:43:51Z) — scripts/moment-updates.mjs never
 *     read that file.
 *
 * Every fixture below is copied from the real record, never invented:
 *   - rolls 236/240/242/243: data/votes.json as of 2026-09-24 (per-member
 *     position arrays omitted — nothing here reads them);
 *   - roll 244: https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00244.xml,
 *     fetched 2026-09-25 (vote_question_text, vote_result, count);
 *   - the update rows and revisions: data/moment-updates.json as of
 *     2026-09-24, ids verbatim (each id is re-derived below, so a fixture
 *     that drifted from its content would fail loudly).
 *
 * ZERO network and ZERO model calls: every Anthropic client here is a stub
 * that records what it was asked. messages/*.json is read (the status
 * phrases), nothing is written.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STALE_PLACEMENT_PHRASE,
  absenceClaims,
  checkMomentUpdates,
  collapseSameActions,
  computeUpdateId,
  dedupeUpdates,
  flapStatusChangeIds,
  lintRevisionText,
  pruneEntry,
  revertingSlugs,
  revisionsOnDay,
  sameActionKey,
  summaryRefreshReason,
} from '../lib/moment-updates-gate.mjs';
import {
  fallbackTextFor,
  floorPendingVehicles,
  rollCallCandidates,
  rollCallToCandidate,
} from '../scripts/moment-updates-map.mjs';
import {
  freshCandidates,
  generateStateSummary,
  lintPair,
  planSummaries,
  statusUnsupported,
  voteGroundingLine,
  writeSummaries,
} from '../scripts/moment-updates.mjs';

/* ------------------------------------------------------------------ *
 * Fixtures — the real record.
 * ------------------------------------------------------------------ */

const SENATE_XML = (n: number) =>
  `https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_${String(n).padStart(5, '0')}.xml`;

const ROLL_236 = {
  id: 's-119-2-236', chamber: 'senate', congress: 119, session: 2, roll: 236, date: '2026-09-17',
  question: 'On the Motion to Proceed S. 4668', result: 'Motion to Proceed Agreed to', bill: 's-4668-119',
  totals: { yea: 77, nay: 22, present: 0, notVoting: 1 }, source: SENATE_XML(236),
};
const ROLL_240 = {
  id: 's-119-2-240', chamber: 'senate', congress: 119, session: 2, roll: 240, date: '2026-09-22',
  question: 'On the Cloture Motion S.Amdt. 6776 to S. 4668 (No short title on file)', result: 'Cloture Motion Agreed to',
  bill: 's-4668-119', totals: { yea: 70, nay: 21, present: 0, notVoting: 9 }, source: SENATE_XML(240),
};
const ROLL_242 = {
  id: 's-119-2-242', chamber: 'senate', congress: 119, session: 2, roll: 242, date: '2026-09-24',
  question: 'On the Amendment S.Amdt. 6776 to S. 4668 (No short title on file)', result: 'Amendment Agreed to',
  bill: 's-4668-119', totals: { yea: 77, nay: 23, present: 0, notVoting: 0 }, source: SENATE_XML(242),
};
const ROLL_243 = {
  id: 's-119-2-243', chamber: 'senate', congress: 119, session: 2, roll: 243, date: '2026-09-24',
  question: 'On the Cloture Motion S. 4668', result: 'Cloture Motion Agreed to', bill: 's-4668-119',
  totals: { yea: 74, nay: 25, present: 0, notVoting: 1 }, source: SENATE_XML(243),
};
/** Not yet in data/votes.json on 2026-09-24 (its Senate cursor stopped at 243). */
const ROLL_244 = {
  id: 's-119-2-244', chamber: 'senate', congress: 119, session: 2, roll: 244, date: '2026-09-24',
  question: 'On the Concurrent Resolution H.Con.Res. 89', result: 'Concurrent Resolution Rejected', bill: 'hconres-89-119',
  totals: { yea: 49, nay: 50, present: 0, notVoting: 1 }, source: SENATE_XML(244),
};

/** iran-war-powers s_088cc923 — the published text, verbatim. */
const FALSE_ABSENCE = {
  en: 'Where it stands: four related measures sit at different points, with no floor or committee action recorded in the last 14 days. S.J.Res. 185 and S.J.Res. 172 both show floor activity. H. Con. Res. 38 also shows floor activity. H. Con. Res. 89 has passed one chamber. No new votes, tallies, or roll-call numbers have been recorded for any of these measures in this period. Their status remains as listed above, unchanged from the prior record. No committee markups, amendments, or scheduling notices appear in the record for this window. Readers tracking these measures will find the current standing unchanged from the last reported update.',
  es: 'Cómo están las cosas: cuatro medidas relacionadas se encuentran en distintas etapas, sin actividad de pleno o de comité registrada en los últimos 14 días. S.J.Res. 185 y S.J.Res. 172 muestran actividad en el pleno. H. Con. Res. 38 también muestra actividad en el pleno. H. Con. Res. 89 fue aprobada por una cámara. No se registraron nuevas votaciones, conteos ni números de votación nominal para ninguna de estas medidas en este período. Su estado se mantiene igual al indicado arriba, sin cambios respecto al registro anterior. No aparecen en el registro sesiones de comité, enmiendas ni avisos de calendario durante esta ventana. Los lectores que sigan estas medidas encontrarán la situación actual sin cambios desde la última actualización reportada.',
};

/** A summary that states the record — what the model is now asked to write. */
const GROUNDED_SUMMARY = {
  en: 'On September 24, 2026, the Senate rejected H. Con. Res. 89 by a recorded vote of 49 to 50 (Roll no. 244). The House agreed to it on July 23, 2026, by a recorded vote of 214 to 208 (Roll no. 282). S.J.Res. 185 and S.J.Res. 172 show floor activity, and H. Con. Res. 38 shows floor activity.',
  es: 'El 24 de septiembre de 2026, el Senado rechazó H. Con. Res. 89 por votación nominal de 49 a 50 (votación núm. 244). La Cámara la aprobó el 23 de julio de 2026 por votación nominal de 214 a 208 (votación núm. 282). S.J.Res. 185 y S.J.Res. 172 muestran actividad en el pleno, y H. Con. Res. 38 también.',
};

const IRAN_VEHICLES = ['sjres-185-119', 'sjres-172-119', 'hconres-38-119', 'hconres-89-119'];
const IRAN_STATUSES = {
  'sjres-185-119': 'floor_vote',
  'sjres-172-119': 'floor_vote',
  'hconres-38-119': 'floor_vote',
  'hconres-89-119': 'passed_chamber',
};

/** Seven s-4668-119 rows from data/moment-updates.json, verbatim — three pairs of one action each, and one distinct action. */
function collegeRow(id: string, day: string, recordedAt: string, actionText: string) {
  return {
    id,
    class: 'floor_action',
    vehicle: 's-4668-119',
    day,
    occurred_at: day,
    occurred_precision: 'day',
    recorded_at: recordedAt,
    text: { en: 'x', es: 'x' },
    source: { kind: 'congress_actions', refs: ['https://www.congress.gov/bill/119th-congress/senate-bill/4668'] },
    record: { action_text: actionText, action_code: null, action_type: 'Floor', source_system: 'Senate' },
    ai: true,
  };
}
const U_F0DB9993 = collegeRow('u_f0db9993', '2026-09-17', '2026-09-18T14:29:25.757Z', 'Cloture motion on the measure presented in Senate.');
const U_05246D80 = collegeRow('u_05246d80', '2026-09-17', '2026-09-23T16:51:20.985Z', 'Cloture motion on the measure presented in Senate. (CR S4789)');
const U_86B9E54F = collegeRow('u_86b9e54f', '2026-09-17', '2026-09-18T14:29:25.757Z', 'Motion to proceed to measure considered in Senate.');
const U_D15DAE4C = collegeRow('u_d15dae4c', '2026-09-17', '2026-09-23T16:51:20.985Z', 'Motion to proceed to measure considered in Senate. (CR S4773-4774)');
const U_732A58B6 = collegeRow('u_732a58b6', '2026-09-16', '2026-09-17T16:56:55.134Z', 'Motion to proceed to measure considered in Senate.');
const U_48567655 = collegeRow('u_48567655', '2026-09-16', '2026-09-23T16:51:20.985Z', 'Motion to proceed to measure considered in Senate. (CR S4743)');
const U_682CCA41 = collegeRow('u_682cca41', '2026-09-17', '2026-09-18T14:29:25.757Z', 'Cloture motion on amendment SA 6776 presented in Senate.');
const COLLEGE_ROWS = [U_F0DB9993, U_05246D80, U_86B9E54F, U_D15DAE4C, U_732A58B6, U_48567655, U_682CCA41];

/** An Anthropic-shaped stub that records every prompt it is sent. */
function recordingClient(reply: string) {
  const prompts: string[] = [];
  return {
    prompts,
    messages: {
      create: async (args: { messages: { content: string }[] }) => {
        prompts.push(args.messages[0].content);
        return { content: [{ type: 'text', text: reply }] };
      },
    },
  };
}

test('the fixtures are the real rows: every id re-derives from its own content', () => {
  for (const row of COLLEGE_ROWS) {
    expect(computeUpdateId('paying-college-athletes', row), row.id).toBe(row.id);
  }
});

/* ------------------------------------------------------------------ *
 * 1 · data/votes.json becomes record events.
 * ------------------------------------------------------------------ */
test.describe('roll calls from data/votes.json become vote updates', () => {
  test('roll 244 becomes a vote whose record is the vote record, verbatim — question, result, tally, date, source', () => {
    const c = rollCallToCandidate({ momentId: 'iran-war-powers', vehicle: 'hconres-89-119', roll: ROLL_244, recordedAt: '2026-09-24T20:07:00Z' })!;
    expect(c).not.toBeNull();
    expect(c.class).toBe('vote');
    expect(c.day).toBe('2026-09-24');
    expect(c.ai).toBe(false);
    expect(c.source.kind).toBe('roll_call');
    expect(c.source.refs[0]).toBe(SENATE_XML(244));
    expect(c.record.roll_call).toEqual({ chamber: 'senate', number: 244 });
    expect(c.record.question).toBe('On the Concurrent Resolution H.Con.Res. 89');
    expect(c.record.result).toBe('Concurrent Resolution Rejected');
    expect(c.record.totals).toEqual({ yea: 49, nay: 50, present: 0, notVoting: 1 });
    expect(c.record.action_text).toBe(
      'On the Concurrent Resolution H.Con.Res. 89: Concurrent Resolution Rejected. Yeas 49, Nays 50, Not Voting 1. Senate roll call vote 244.',
    );
    expect(c.id).toBe(computeUpdateId('iran-war-powers', c));
  });

  test('the SAME roll call from the vote record and from /actions is ONE id — no double row', () => {
    // u_a3cc6ca3 is the /actions-sourced row data/moment-updates.json already
    // stores for Senate roll 236 on S. 4668 (2026-09-17). The vote record's
    // copy of the same roll hashes to the same id, so it is recognised as
    // already stored rather than added beside it.
    const c = rollCallToCandidate({ momentId: 'paying-college-athletes', vehicle: 's-4668-119', roll: ROLL_236 })!;
    expect(c.id).toBe('u_a3cc6ca3');
  });

  test('the ai:false fallback quotes ONLY what the record wrote, fits the ceiling, and clears the lint in both languages', () => {
    for (const roll of [ROLL_240, ROLL_242, ROLL_243, ROLL_244]) {
      const c = rollCallToCandidate({ momentId: 'm', vehicle: roll.bill, roll })!;
      const text = fallbackTextFor(c);
      expect(text.en).toContain(`roll call vote ${roll.roll}`);
      expect(text.en).toContain(`Yeas ${roll.totals.yea}, Nays ${roll.totals.nay}`);
      expect(text.es).toContain(`a favor ${roll.totals.yea}, en contra ${roll.totals.nay}`);
      // The quotation marks hold the record's own strings and nothing of ours.
      const quoted = [...text.en.matchAll(/“([^”]*)”/g)].map((m) => m[1]);
      expect(quoted).toEqual([roll.question, roll.result]);
      expect(lintPair(text, 'vote', [])).toEqual([]);
    }
    expect(fallbackTextFor(rollCallToCandidate({ momentId: 'm', vehicle: 'hconres-89-119', roll: ROLL_244 })!)).toEqual({
      en: 'Senate roll call vote 244: “On the Concurrent Resolution H.Con.Res. 89” — “Concurrent Resolution Rejected”; Yeas 49, Nays 50, Not Voting 1.',
      es: 'Votación nominal 244 del Senado, registro oficial en inglés: “On the Concurrent Resolution H.Con.Res. 89” — “Concurrent Resolution Rejected”; a favor 49, en contra 50, no votaron 1.',
    });
  });

  test('the gate accepts a roll_call-sourced update exactly as it is stored', () => {
    const c = rollCallToCandidate({ momentId: 'iran-war-powers', vehicle: 'hconres-89-119', roll: ROLL_244, recordedAt: '2026-09-24T20:07:00Z' })!;
    c.text = fallbackTextFor(c);
    const { violations } = checkMomentUpdates(
      { _meta: { schema: 1, generated_at: '2026-09-24T20:07:00Z' }, 'iran-war-powers': { updates: [c], summary_revisions: [] } },
      { 'iran-war-powers': { status: 'live', vehicles: IRAN_VEHICLES.map((slug) => ({ slug })) } },
      new Set(IRAN_VEHICLES),
      { now: Date.parse('2026-09-24T21:00:00Z') },
    );
    expect(violations).toEqual([]);
  });

  test('only rolls on a moment vehicle, inside retention and not in the future, become candidates', () => {
    const out = rollCallCandidates({
      vehicles: [{ momentId: 'paying-college-athletes', slug: 's-4668-119' }],
      rollCalls: [ROLL_236, ROLL_240, ROLL_242, ROLL_243, ROLL_244],
      retentionFloor: '2026-09-20',
      todayET: '2026-09-24',
    });
    // 236 is before the floor; 244 is on another bill.
    expect(out.map((c) => c.record.roll_call.number)).toEqual([240, 242, 243]);
    expect(out.every((c: Record<string, unknown>) => c.__moment === 'paying-college-athletes')).toBe(true);
  });

  test('a roll call with no question or no result is never papered over', () => {
    expect(rollCallToCandidate({ momentId: 'm', vehicle: 'hconres-89-119', roll: { ...ROLL_244, question: null } })).toBeNull();
    expect(rollCallToCandidate({ momentId: 'm', vehicle: 'hconres-89-119', roll: { ...ROLL_244, result: '' } })).toBeNull();
    // …and a roll on a different bill is not this vehicle's.
    expect(rollCallToCandidate({ momentId: 'm', vehicle: 'sjres-185-119', roll: ROLL_244 })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 2 · The votes reach the "Where it stands" prompt.
 * ------------------------------------------------------------------ */
test.describe('the vote rows are grounding for "Where it stands"', () => {
  test('the prompt carries every roll call verbatim, and says the record is not empty', async () => {
    const client = recordingClient(JSON.stringify(GROUNDED_SUMMARY));
    const entry = { updates: [], summary_revisions: [] };
    const revision = await generateStateSummary(client, 'iran-war-powers', entry, IRAN_STATUSES, [], {}, [ROLL_244]);

    expect(client.prompts).toHaveLength(1);
    const prompt = client.prompts[0];
    expect(prompt).toContain(
      '- 2026-09-24 · Senate roll call no. 244 · H. Con. Res. 89 · question: "On the Concurrent Resolution H.Con.Res. 89" · result: "Concurrent Resolution Rejected" · Yeas 49, Nays 50, Present 0, Not Voting 1',
    );
    expect(prompt).toContain('The record below is NOT empty');
    // The invitation that produced the 18:57Z sentence is gone when the record is not empty.
    expect(prompt).not.toContain('If nothing has moved recently, say that plainly.');

    expect(revision).not.toBeNull();
    expect(revision!.grounded_in.roll_calls).toEqual(['s-119-2-244']);
  });

  test("S. 4668's three same-week rolls all reach the prompt (the 18:57:12Z revision had none of them)", async () => {
    const client = recordingClient(JSON.stringify({ en: 'x', es: 'x' }));
    await generateStateSummary(
      client,
      'paying-college-athletes',
      { updates: [], summary_revisions: [] },
      { 's-4668-119': 'floor_vote' },
      [],
      {},
      [ROLL_243, ROLL_242, ROLL_240],
    );
    for (const roll of [ROLL_240, ROLL_242, ROLL_243]) expect(client.prompts[0]).toContain(voteGroundingLine(roll));
  });

  test('with an empty record the old instruction stands — nothing about quiet weeks changed', async () => {
    const client = recordingClient(JSON.stringify({ en: 'Nothing has moved.', es: 'Nada se ha movido.' }));
    const revision = await generateStateSummary(client, 'test-moment', { updates: [], summary_revisions: [] }, { 's-4668-119': 'floor_vote' }, [], {}, []);
    expect(client.prompts[0]).toContain('If nothing has moved recently, say that plainly.');
    expect(client.prompts[0]).toContain('- no roll call recorded on these measures in this window');
    // An absence claim over an EMPTY record is not a lie, and is not rejected.
    expect(revision).not.toBeNull();
    expect(revision!.grounded_in.roll_calls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 3 · The absence lint.
 * ------------------------------------------------------------------ */
test.describe('the absence lint', () => {
  test('rejects the 18:57Z text, in English AND Spanish, when the grounding holds a vote', () => {
    const en = lintRevisionText(FALSE_ABSENCE.en, 'en', { groundedEvents: true });
    const es = lintRevisionText(FALSE_ABSENCE.es, 'es', { groundedEvents: true });
    expect(en.some((f: string) => f.startsWith('absence claim'))).toBe(true);
    expect(es.some((f: string) => f.startsWith('absence claim'))).toBe(true);
    // Every one of the paragraph's absence sentences is caught on its own, not
    // just the first — and the sentences that only state a status are not.
    const absentEn = [
      'Where it stands: four related measures sit at different points, with no floor or committee action recorded in the last 14 days.',
      'No new votes, tallies, or roll-call numbers have been recorded for any of these measures in this period.',
      'Their status remains as listed above, unchanged from the prior record.',
      'No committee markups, amendments, or scheduling notices appear in the record for this window.',
      'Readers tracking these measures will find the current standing unchanged from the last reported update.',
    ];
    const absentEs = [
      'Cómo están las cosas: cuatro medidas relacionadas se encuentran en distintas etapas, sin actividad de pleno o de comité registrada en los últimos 14 días.',
      'No se registraron nuevas votaciones, conteos ni números de votación nominal para ninguna de estas medidas en este período.',
      'Su estado se mantiene igual al indicado arriba, sin cambios respecto al registro anterior.',
      'No aparecen en el registro sesiones de comité, enmiendas ni avisos de calendario durante esta ventana.',
      'Los lectores que sigan estas medidas encontrarán la situación actual sin cambios desde la última actualización reportada.',
    ];
    for (const s of absentEn) {
      expect(FALSE_ABSENCE.en).toContain(s);
      expect(absenceClaims(s, 'en'), s).not.toEqual([]);
    }
    for (const s of absentEs) {
      expect(FALSE_ABSENCE.es).toContain(s);
      expect(absenceClaims(s, 'es'), s).not.toEqual([]);
    }
    expect(absenceClaims('S.J.Res. 185 and S.J.Res. 172 both show floor activity. H. Con. Res. 89 has passed one chamber.', 'en')).toEqual([]);
    expect(absenceClaims('S.J.Res. 185 y S.J.Res. 172 muestran actividad en el pleno. H. Con. Res. 89 fue aprobada por una cámara.', 'es')).toEqual([]);
  });

  test('…and the run keeps the previous revision: generateStateSummary returns null, nothing is appended', async () => {
    const previous = { id: 's_71587d77', text: { en: 'Prior.', es: 'Previo.' } };
    const entry = { updates: [], summary_revisions: [previous] };
    const client = recordingClient(JSON.stringify(FALSE_ABSENCE));
    const revision = await generateStateSummary(client, 'iran-war-powers', entry, IRAN_STATUSES, [], {}, [ROLL_244]);
    expect(client.prompts).toHaveLength(1);
    expect(revision).toBeNull();
    expect(entry.summary_revisions).toEqual([previous]);
  });

  test('callers that pass no grounding flag get exactly the two layers they always had', () => {
    expect(lintRevisionText(FALSE_ABSENCE.en, 'en').some((f: string) => f.startsWith('absence'))).toBe(false);
    expect(lintRevisionText(FALSE_ABSENCE.es, 'es').some((f: string) => f.startsWith('absence'))).toBe(false);
  });

  test('a summary that states the record passes — roll and calendar numbers are not "no"', () => {
    expect(absenceClaims(GROUNDED_SUMMARY.en, 'en')).toEqual([]);
    expect(absenceClaims(GROUNDED_SUMMARY.es, 'es')).toEqual([]);
    expect(absenceClaims('Placed on Senate Legislative Calendar under General Orders. Calendar No. 501.', 'en')).toEqual([]);
    expect(absenceClaims('Cloture was not invoked, by a recorded vote of 49 to 50 (Roll no. 234).', 'en')).toEqual([]);
    expect(absenceClaims('The motion drew 49 yes and 50 no votes.', 'en')).toEqual([]);
    expect(absenceClaims('La moción no fue aprobada, por votación nominal de 49 a 50.', 'es')).toEqual([]);
  });

  test('our own aged-placement phrase is exempt, in both languages — the lint and the prompt share one copy', () => {
    expect(absenceClaims(`S. 3172 ${STALE_PLACEMENT_PHRASE.en}.`, 'en')).toEqual([]);
    expect(absenceClaims(`S. 3172 ${STALE_PLACEMENT_PHRASE.es}.`, 'es')).toEqual([]);
  });

  test('the gate ENFORCES it on stored revisions written by this collector (grounded_in.roll_calls present)', () => {
    const c = rollCallToCandidate({ momentId: 'iran-war-powers', vehicle: 'hconres-89-119', roll: ROLL_244, recordedAt: '2026-09-24T20:07:00Z' })!;
    c.text = fallbackTextFor(c);
    const revision = (text: { en: string; es: string }, rollCalls?: string[]) => ({
      id: 's_0000abcd',
      generated_at: '2026-09-24T20:08:00Z',
      as_of_day: '2026-09-24',
      text,
      grounded_in: {
        vehicle_statuses: IRAN_STATUSES,
        update_ids: [c.id],
        ...(rollCalls ? { roll_calls: rollCalls } : {}),
      },
      changed_because: ['updates:+1'],
      model: 'claude-sonnet-5',
    });
    const run = (rev: Record<string, unknown>) =>
      checkMomentUpdates(
        { _meta: { schema: 1, generated_at: '2026-09-24T20:08:00Z' }, 'iran-war-powers': { updates: [c], summary_revisions: [rev] } },
        { 'iran-war-powers': { status: 'live', vehicles: IRAN_VEHICLES.map((slug) => ({ slug })) } },
        new Set(IRAN_VEHICLES),
        { now: Date.parse('2026-09-24T21:00:00Z') },
      );

    // New-format revision + absence claim over a real vote: a violation.
    const enforced = run(revision(FALSE_ABSENCE, ['s-119-2-244']));
    expect(enforced.violations.some((v: string) => v.includes('absence claim'))).toBe(true);
    // The same text on a revision written before the lint existed: history,
    // never rewritten — flagged as a warning on the current revision only.
    const legacy = run(revision(FALSE_ABSENCE));
    expect(legacy.violations.some((v: string) => v.includes('absence claim'))).toBe(false);
    expect(legacy.warnings.some((w: string) => w.includes('absence claim'))).toBe(true);
    // A grounded summary is clean under enforcement.
    expect(run(revision(GROUNDED_SUMMARY, ['s-119-2-244'])).violations).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 4 · The flap guard.
 * ------------------------------------------------------------------ */
test.describe('the flap guard — a status that reverts inside 48h buys no rewrite', () => {
  /** iran-war-powers' first two revisions, verbatim statuses and stamps. */
  const iranSeed = { id: 's_d26a6b43', generated_at: '2026-07-25T06:20:00Z', grounded_in: { vehicle_statuses: { 'sjres-185-119': 'floor_vote', 'sjres-172-119': 'floor_vote', 'hconres-38-119': 'committee', 'hconres-89-119': 'passed_chamber' }, update_ids: [] } };
  const iranFlip = { id: 's_1acc71ee', generated_at: '2026-07-25T20:03:31.611Z', grounded_in: { vehicle_statuses: { 'sjres-185-119': 'committee', 'sjres-172-119': 'committee', 'hconres-38-119': 'committee', 'hconres-89-119': 'passed_chamber' }, update_ids: [] } };
  const flippedBack = { 'sjres-185-119': 'floor_vote', 'sjres-172-119': 'floor_vote', 'hconres-38-119': 'committee', 'hconres-89-119': 'passed_chamber' };

  test('sjres-185/172 floor_vote→committee→floor_vote (2026-07-25/26): the flip back is not movement', () => {
    const entry = { updates: [], summary_revisions: [iranSeed, iranFlip] };
    // s_5ee764db was generated at 2026-07-26T09:35Z for exactly this flip back.
    const at = Date.parse('2026-07-26T09:35:09Z');
    expect([...revertingSlugs(entry, flippedBack, at)].sort()).toEqual(['sjres-172-119', 'sjres-185-119']);
    expect(summaryRefreshReason(entry, flippedBack, at)).toBeNull();
  });

  test('outside the 48h window the same change IS movement', () => {
    const entry = { updates: [], summary_revisions: [iranSeed, iranFlip] };
    expect(summaryRefreshReason(entry, flippedBack, Date.parse('2026-07-28T12:00:00Z'))).toBe('status sjres-185-119');
  });

  test('s-4668-119 committee→floor_vote (2026-09-24) reverts the one-night misread — but a real new event still triggers', () => {
    const before = { id: 's_7e143c92', generated_at: '2026-09-18T17:56:27.567Z', grounded_in: { vehicle_statuses: { 's-4668-119': 'floor_vote' }, update_ids: [] } };
    const misread = { id: 's_c0bcbd35', generated_at: '2026-09-23T19:17:36.831Z', grounded_in: { vehicle_statuses: { 's-4668-119': 'committee' }, update_ids: [] } };
    // u_c6a1ebcb: the stored floor_vote→committee status_change, recorded before the misread revision.
    const statusChange = { id: 'u_c6a1ebcb', class: 'status_change', vehicle: 's-4668-119', day: '2026-09-22', recorded_at: '2026-09-23T16:51:20.985Z', record: { status_from: 'floor_vote', status_to: 'committee' } };
    const at = Date.parse('2026-09-24T18:57:12Z');
    const entry = { updates: [statusChange], summary_revisions: [before, misread] };
    expect(summaryRefreshReason(entry, { 's-4668-119': 'floor_vote' }, at)).toBeNull();

    // u_2530a6e7, the floor-today listing recorded at 18:07Z, is a record
    // event — the guard never suppresses one of those.
    const listing = { id: 'u_2530a6e7', class: 'scheduled', vehicle: 's-4668-119', day: '2026-09-24', recorded_at: '2026-09-24T18:07:05.065Z' };
    expect(summaryRefreshReason({ ...entry, updates: [statusChange, listing] }, { 's-4668-119': 'floor_vote' }, at)).toBe('update u_2530a6e7');
  });

  test('a status_change and its reversal inside 48h are both ignored; 3 days apart they are real', () => {
    const revision = { id: 's_1', generated_at: '2026-09-20T00:00:00Z', grounded_in: { vehicle_statuses: { v: 'floor_vote' }, update_ids: [] } };
    const there = { id: 'u_a', class: 'status_change', vehicle: 'v', recorded_at: '2026-09-21T10:00:00Z', record: { status_from: 'floor_vote', status_to: 'committee' } };
    const back = { id: 'u_b', class: 'status_change', vehicle: 'v', recorded_at: '2026-09-22T09:00:00Z', record: { status_from: 'committee', status_to: 'floor_vote' } };
    expect([...flapStatusChangeIds([there, back])].sort()).toEqual(['u_a', 'u_b']);
    expect(summaryRefreshReason({ updates: [there, back], summary_revisions: [revision] }, { v: 'floor_vote' }, Date.parse('2026-09-22T12:00:00Z'))).toBeNull();

    const late = { ...back, recorded_at: '2026-09-24T12:00:00Z' };
    expect(flapStatusChangeIds([there, late]).size).toBe(0);
    expect(summaryRefreshReason({ updates: [there, late], summary_revisions: [revision] }, { v: 'floor_vote' }, Date.parse('2026-09-24T13:00:00Z'))).not.toBeNull();
  });

  test('a status its own status sentence does not support is not a trigger', () => {
    const revision = { id: 's_1', generated_at: '2026-09-20T00:00:00Z', grounded_in: { vehicle_statuses: { v: 'floor_vote' }, update_ids: [] } };
    const at = Date.parse('2026-09-21T00:00:00Z');
    const entry = { updates: [], summary_revisions: [revision] };
    expect(summaryRefreshReason(entry, { v: 'committee' }, at)).toBe('status v');
    expect(summaryRefreshReason(entry, { v: 'committee' }, at, { unsupported: new Set(['v']) })).toBeNull();

    // The runner's predicate: status must equal mapStatus(statusBasisText(bill)).
    const placement = 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 501.';
    expect(statusUnsupported({ status: 'floor_vote', last_action_text: placement })).toBe(false);
    expect(statusUnsupported({ status: 'committee', last_action_text: placement })).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 5 · Dedupe — the same action, re-worded with a "(CR …)" citation.
 * ------------------------------------------------------------------ */
test.describe('same-action dedupe keeps the earliest row', () => {
  test('all three real pairs collapse to the row recorded first; distinct actions stay', () => {
    const merged = dedupeUpdates([], COLLEGE_ROWS);
    const ids = merged.map((u) => u.id).sort();
    expect(ids).toEqual(['u_682cca41', 'u_732a58b6', 'u_86b9e54f', 'u_f0db9993']);
  });

  test('order does not matter — the late row arriving first still loses', () => {
    expect(dedupeUpdates([U_05246D80], [U_F0DB9993]).map((u) => u.id)).toEqual(['u_f0db9993']);
    expect(dedupeUpdates([U_F0DB9993], [U_05246D80]).map((u) => u.id)).toEqual(['u_f0db9993']);
  });

  test('the key is the action: another day, another chamber, or another sentence is another action', () => {
    expect(sameActionKey(U_F0DB9993)).toBe(sameActionKey(U_05246D80));
    expect(sameActionKey(U_86B9E54F)).not.toBe(sameActionKey(U_732A58B6)); // same text, different day
    const house = { ...U_F0DB9993, record: { ...U_F0DB9993.record, source_system: 'House floor actions', action_text: 'Cloture motion on the measure presented in House.' } };
    expect(sameActionKey(house)).not.toBe(sameActionKey(U_F0DB9993));
    expect(sameActionKey(U_682CCA41)).not.toBe(sameActionKey(U_F0DB9993));
    // Roll calls are keyed by their number elsewhere and never reach this key.
    expect(sameActionKey(rollCallToCandidate({ momentId: 'm', vehicle: 'hconres-89-119', roll: ROLL_244 })!)).toBeNull();
  });

  test('prune collapses already-stored pairs and carries every citation to the survivor', () => {
    const revision = {
      id: 's_c0bcbd35',
      generated_at: '2026-09-23T19:17:36.831Z',
      as_of_day: '2026-09-23',
      text: { en: 'x', es: 'x' },
      grounded_in: { vehicle_statuses: { 's-4668-119': 'committee' }, update_ids: COLLEGE_ROWS.map((r) => r.id), refs: [] },
      changed_because: ['updates:+5'],
      model: 'claude-sonnet-5',
    };
    const pruned = pruneEntry({ updates: COLLEGE_ROWS, summary_revisions: [revision] }, { now: Date.parse('2026-09-25T02:00:00Z') })!;
    expect(pruned.updates.map((u: { id: string }) => u.id).sort()).toEqual(['u_682cca41', 'u_732a58b6', 'u_86b9e54f', 'u_f0db9993']);
    expect([...pruned.summary_revisions[0].grounded_in.update_ids].sort()).toEqual(['u_682cca41', 'u_732a58b6', 'u_86b9e54f', 'u_f0db9993']);
  });

  test('the collector does not re-collect (or re-pay to decode) a re-worded row it already holds', () => {
    const store = { 'paying-college-athletes': { updates: [U_F0DB9993], summary_revisions: [] } };
    const reworded = { ...U_05246D80, __moment: 'paying-college-athletes' };
    const roll = { ...rollCallToCandidate({ momentId: 'paying-college-athletes', vehicle: 's-4668-119', roll: ROLL_243 })!, __moment: 'paying-college-athletes' };
    expect(freshCandidates([reworded, roll], store).map((c) => c.id)).toEqual([roll.id]);
  });

  test('a roll call already stored on ANOTHER day is not stored twice', () => {
    const stored = { ...rollCallToCandidate({ momentId: 'iran-war-powers', vehicle: 'hconres-89-119', roll: ROLL_244 })! };
    const otherDay = { ...rollCallToCandidate({ momentId: 'iran-war-powers', vehicle: 'hconres-89-119', roll: { ...ROLL_244, date: '2026-09-25' } })!, __moment: 'iran-war-powers' };
    expect(otherDay.id).not.toBe(stored.id);
    expect(freshCandidates([otherDay], { 'iran-war-powers': { updates: [stored], summary_revisions: [] } })).toEqual([]);
  });

  test('the real store: pruning collapses exactly the three measured pairs and the gate stays clean', () => {
    const real = JSON.parse(readFileSync(join(process.cwd(), 'data/moment-updates.json'), 'utf8'));
    const moments = JSON.parse(readFileSync(join(process.cwd(), 'data/moments.json'), 'utf8'));
    const bills: { full_identifier: string }[] = JSON.parse(readFileSync(join(process.cwd(), 'data/bills.json'), 'utf8'));
    const entry = real['paying-college-athletes'];
    const present = ['u_05246d80', 'u_d15dae4c', 'u_48567655'].filter((id) => entry.updates.some((u: { id: string }) => u.id === id));
    // The pipeline will have pruned these the first time it runs; the pin is
    // only meaningful while the pairs are still in the committed file.
    test.skip(present.length === 0, 'the committed file no longer carries the 2026-09-24 duplicate pairs');
    const { kept, remap } = collapseSameActions(entry.updates);
    expect(entry.updates.length - kept.length).toBe(present.length);
    for (const id of present) expect(remap.has(id)).toBe(true);

    const pruned = pruneEntry(entry, { now: Date.now() });
    const next = { ...real, 'paying-college-athletes': pruned };
    const { violations } = checkMomentUpdates(next, moments, new Set(bills.map((b) => b.full_identifier)));
    expect(violations).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 6 · Intraday regeneration, its cap, and the floor guard — no model calls.
 * ------------------------------------------------------------------ */
test.describe('intraday regeneration: only on a landed vote, 3 per question per ET day', () => {
  const MOMENTS = { 'iran-war-powers': { status: 'live', vehicles: IRAN_VEHICLES.map((slug) => ({ slug })) } };
  const BILLS = new Map(
    Object.entries(IRAN_STATUSES).map(([slug, status]) => [slug, { full_identifier: slug, status, last_action_text: null, last_action_date: null }]),
  );
  /** 16:00 ET on 2026-09-24. */
  const NOW = Date.parse('2026-09-24T20:00:00Z');
  const rev = (id: string, generatedAt: string) => ({
    id,
    generated_at: generatedAt,
    grounded_in: { vehicle_statuses: IRAN_STATUSES, update_ids: [] },
  });
  const storeWith = (revisions: unknown[]) => ({ 'iran-war-powers': { updates: [], summary_revisions: revisions } });
  const plan = (over: Record<string, unknown>) =>
    planSummaries({
      mode: 'incremental',
      moments: MOMENTS,
      store: storeWith([rev('s_088cc923', '2026-09-24T18:57:01.886Z')]),
      billBySlug: BILLS,
      rollCalls: [ROLL_244],
      floorSignals: null,
      landedVotes: new Set(['iran-war-powers']),
      now: NOW,
      unsupportedStatus: () => false,
      ...over,
    });

  test('roll 244 lands → one rewrite, grounded in roll 244', () => {
    const [p] = plan({});
    expect(p.generate).toBe(true);
    expect(p.votes.map((r) => r.id)).toEqual(['s-119-2-244']);
  });

  test('a fourth rewrite on the same ET day is refused — the cap reads the stored file', () => {
    const three = storeWith([
      rev('s_1', '2026-09-24T14:20:00Z'),
      rev('s_2', '2026-09-24T18:57:01Z'),
      // 02:00Z on the 25th is 22:00 ET on the 24th: it counts for the 24th.
      rev('s_3', '2026-09-25T02:00:00Z'),
    ]);
    expect(revisionsOnDay(three['iran-war-powers'], '2026-09-24')).toBe(3);
    const [p] = plan({ store: three, now: Date.parse('2026-09-25T03:00:00Z') });
    expect(p.generate).toBe(false);
    expect(p.reason).toContain('intraday cap 3');
    // Two is under the cap.
    const two = storeWith([rev('s_1', '2026-09-24T14:20:00Z'), rev('s_2', '2026-09-24T18:57:01Z')]);
    expect(plan({ store: two })[0].generate).toBe(true);
  });

  test('REJECTED replies spend the cap too — it bounds model calls, not only successes', async () => {
    let calls = 0;
    const rejecting = {
      messages: {
        create: async () => {
          calls++;
          return { content: [{ type: 'text', text: JSON.stringify(FALSE_ABSENCE) }] };
        },
      },
    };
    const store = storeWith([rev('s_088cc923', '2026-09-24T18:57:01.886Z')]);
    // Three landings in a row, every reply rejected by the absence lint.
    for (let i = 0; i < 3; i++) {
      const written = await writeSummaries({ plan: plan({ store }), store, moments: MOMENTS, anthropic: rejecting });
      expect(written).toBe(0);
    }
    expect(calls).toBe(3);
    expect(store['iran-war-powers']).toMatchObject({ summary_attempts: { day: '2026-09-24', count: 3 } });
    // The fourth landing that day makes no call at all.
    const [fourth] = plan({ store });
    expect(fourth.generate).toBe(false);
    expect(fourth.reason).toContain('3 intraday attempt(s)');
    await writeSummaries({ plan: [fourth], store, moments: MOMENTS, anthropic: rejecting });
    expect(calls).toBe(3);
    // Nothing was appended: the previous revision stands through all of it.
    expect(store['iran-war-powers'].summary_revisions).toHaveLength(1);
    // A counter from yesterday is stale and reads as zero.
    expect(plan({ store, now: Date.parse('2026-09-25T15:00:00Z') })[0].generate).toBe(true);
  });

  test('the gate accepts a well-formed attempt counter and rejects a malformed one', () => {
    const run = (attempts: unknown) =>
      checkMomentUpdates(
        { _meta: { schema: 1, generated_at: '2026-09-24T20:00:00Z' }, 'iran-war-powers': { updates: [], summary_revisions: [], summary_attempts: attempts } },
        MOMENTS,
        new Set(IRAN_VEHICLES),
        { now: NOW },
      ).violations;
    expect(run({ day: '2026-09-24', count: 2 })).toEqual([]);
    expect(run({ day: '2026-09-24', count: -1 }).length).toBe(1);
    expect(run({ day: 'yesterday', count: 1 }).length).toBe(1);
    expect(run({ day: '2026-09-30', count: 1 }).some((v: string) => v.includes('future'))).toBe(true);
  });

  test('no landed vote, no intraday rewrite — whatever else moved', () => {
    expect(plan({ landedVotes: new Set() })).toEqual([]);
  });

  test('the nightly is not stopped by the intraday cap (its behaviour is unchanged)', () => {
    const three = storeWith([rev('s_1', '2026-09-24T10:00:00Z'), rev('s_2', '2026-09-24T12:00:00Z'), rev('s_3', '2026-09-24T13:00:00Z')]);
    const bumped = new Map(BILLS);
    bumped.set('hconres-89-119', { ...BILLS.get('hconres-89-119')!, status: 'floor_vote' });
    const [p] = plan({ mode: 'nightly', store: three, billBySlug: bumped, landedVotes: new Set() });
    expect(p.generate).toBe(true);
    expect(p.reason).toBe('status hconres-89-119');
  });

  test('the floor guard defers while the floor is live and today\'s roll call is not in yet', () => {
    // data/floor-signals.json on 2026-09-24, verbatim fields.
    const floorSignals = {
      signals: {
        's-4668-119': { tier0: { source: 'daily-digest', chamber: 'senate', covers: '2026-09-24', certainty: 'scheduled_vote' } },
      },
    };
    expect(floorPendingVehicles({ slugs: ['s-4668-119'], todayET: '2026-09-24', rollCalls: [ROLL_240], floorSignals })).toEqual([
      { slug: 's-4668-119', signals: ['floor-signals scheduled_vote (daily-digest)'] },
    ]);
    // Rolls 242/243 (dated 2026-09-24) lift it.
    expect(floorPendingVehicles({ slugs: ['s-4668-119'], todayET: '2026-09-24', rollCalls: [ROLL_242, ROLL_243], floorSignals })).toEqual([]);
    // A floor-today listing on the question's own vehicle defers too, and a
    // same-day roll lifts it.
    const listing = { id: 'u_3b1d76f0', class: 'scheduled', vehicle: 'hconres-89-119', day: '2026-09-24', record: { source_system: 'Congress.gov senate-floor-today RSS' } };
    const deferred = plan({ store: { 'iran-war-powers': { updates: [listing], summary_revisions: [] } }, rollCalls: [], landedVotes: new Set(['iran-war-powers']) });
    expect(deferred[0].generate).toBe(false);
    expect(deferred[0].reason).toContain('deferred');
    const lifted = plan({ store: { 'iran-war-powers': { updates: [listing], summary_revisions: [] } } });
    expect(lifted[0].generate).toBe(true);
  });

  test('ZERO model calls for anything the plan did not mark generate — and one call when it did', async () => {
    let calls = 0;
    const counting = {
      messages: {
        create: async () => {
          calls++;
          return { content: [{ type: 'text', text: JSON.stringify(GROUNDED_SUMMARY) }] };
        },
      },
    };
    const three = storeWith([rev('s_1', '2026-09-24T10:00:00Z'), rev('s_2', '2026-09-24T12:00:00Z'), rev('s_3', '2026-09-24T13:00:00Z')]);
    const capped = plan({ store: three });
    expect(await writeSummaries({ plan: capped, store: three, moments: MOMENTS, anthropic: counting })).toBe(0);
    expect(calls).toBe(0);

    const open = storeWith([rev('s_088cc923', '2026-09-24T18:57:01.886Z')]);
    const written = await writeSummaries({ plan: plan({ store: open }), store: open, moments: MOMENTS, anthropic: counting });
    expect(calls).toBe(1);
    expect(written).toBe(1);
    const appended = open['iran-war-powers'].summary_revisions.at(-1) as { grounded_in: { roll_calls: string[] } };
    expect(appended.grounded_in.roll_calls).toEqual(['s-119-2-244']);

    // The per-run cap holds even with a plan that says generate.
    calls = 0;
    const again = storeWith([rev('s_088cc923', '2026-09-24T18:57:01.886Z')]);
    expect(await writeSummaries({ plan: plan({ store: again }), store: again, moments: MOMENTS, anthropic: counting, cap: 0 })).toBe(0);
    expect(calls).toBe(0);
  });
});
