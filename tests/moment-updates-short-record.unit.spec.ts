import { expect, test } from '@playwright/test';
/*
 * A short record makes a short summary (2026-10-01).
 *
 * THE FAILURE: the penny question's first "Where it stands" was paid for and
 * rejected by the absence lint every nightly from 2026-09-26 to 2026-09-30,
 * so the page never showed one. Its 14-day window holds two actions, both on
 * 2026-09-28, and the prompt asked for 90 to 140 words. Two sentences cannot
 * fill 90 words, so the model padded, and the padding was absence claims
 * about the measures that did not move.
 *
 * THE MEASUREMENT (throwaway workflow run 36884798035, real model, six calls
 * per prompt): the old length line, 3 of 6 rejected; SHORT_RECORD_LENGTH_RULE,
 * 6 of 6 accepted at 43 to 49 words. The two replies below are verbatim from
 * that run. ZERO network and ZERO model calls here: the client is a stub.
 *
 * The H.R. 10167 rows' `day` is moved to today's ET day for the same reason
 * tests/moment-updates-without-recorded-vote.unit.spec.ts moves it:
 * generateStateSummary reads its 14-day window off the real clock at import.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { etDay, lintRevisionText } from '../lib/moment-updates-gate.mjs';
import {
  FULL_LENGTH_RULE,
  SHORT_RECORD_LENGTH_RULE,
  SHORT_RECORD_MAX_ITEMS,
  generateStateSummary,
  planSummaries,
  refusedSentences,
} from '../scripts/moment-updates.mjs';

const TODAY = etDay(new Date());

const SENATE_UC_PASSAGE = {
  id: 'u_a1f9a417', class: 'floor_action', vehicle: 'hr-10167-119', day: TODAY,
  record: { action_text: 'Passed Senate without amendment by Unanimous Consent.', action_code: null, action_type: 'Floor', source_system: 'Senate' },
};
const SENATE_UC_DISCHARGE = {
  id: 'u_10792eb6', class: 'floor_action', vehicle: 'hr-10167-119', day: TODAY,
  record: { action_text: 'Senate Committee on Banking, Housing, and Urban Affairs discharged by Unanimous Consent.', action_code: null, action_type: 'Discharge', source_system: 'Senate' },
};
const PENNY_WINDOW = [SENATE_UC_PASSAGE, SENATE_UC_DISCHARGE];

const PENNY_STATUSES = { 'hr-10167-119': 'passed_chamber', 's-1525-119': 'passed_chamber', 'hr-3074-119': 'passed_chamber' };
const PENNY_RECORDS = {
  'hr-10167-119': { lastActionText: 'Passed Senate without amendment by Unanimous Consent.', lastActionDate: '2026-09-28', billType: 'hr', statusBasisText: null },
  's-1525-119': { lastActionText: 'Held at the desk.', lastActionDate: '2026-08-10', billType: 's', statusBasisText: null },
  'hr-3074-119': { lastActionText: 'Received in the Senate and Read twice and referred to the Committee on Banking, Housing, and Urban Affairs.', lastActionDate: '2026-07-15', billType: 'hr', statusBasisText: null },
};

/** Verbatim: run 36884798035, "shortRecord #1" (the new length rule), accepted. */
const SHORT_REPLY = {
  en: 'On September 28, 2026, the Senate passed H.R. 10167 without amendment by unanimous consent. The same day, the Senate Committee on Banking, Housing, and Urban Affairs was discharged from the bill, also by unanimous consent. H.R. 10167 now stands as "Passed both chambers."',
  es: 'El 28 de septiembre de 2026, el Senado aprobó el proyecto H.R. 10167 sin enmiendas por consentimiento unánime. Ese mismo día, el Comité de Banca, Vivienda y Asuntos Urbanos del Senado quedó relevado del proyecto, también por consentimiento unánime. El H.R. 10167 figura como "Aprobado por ambas cámaras".',
};

/** Verbatim: run 36884798035, "baseline #3" (the old 90-to-140 line), rejected. */
const PADDED_REPLY = {
  en: 'On September 28, 2026, the Senate passed H.R. 10167 without amendment by unanimous consent. That same day, the Senate Committee on Banking, Housing, and Urban Affairs was discharged from the bill, also by unanimous consent. A discharge takes a bill out of a committee\'s hands so the full chamber can act on it. Since the Senate passed the bill without changes, the House and Senate have now both passed H.R. 10167. The record for this period shows no other action on the bill. It also lists no recorded votes in this window, because passage by unanimous consent does not involve a roll call. The record for this period shows no new floor action on S. 1525 or H.R. 3074.',
  es: 'El 28 de septiembre de 2026, el Senado aprobó el proyecto H.R. 10167 sin enmiendas por consentimiento unánime. Ese mismo día, el Comité de Banca, Vivienda y Asuntos Urbanos del Senado quedó relevado del proyecto, también por consentimiento unánime. Un relevo retira un proyecto de manos de un comité para que la cámara en pleno pueda actuar sobre él. Como el Senado aprobó el proyecto sin cambios, la Cámara de Representantes y el Senado ya aprobaron ambos el H.R. 10167. El registro de este período no muestra otras acciones sobre el proyecto. Tampoco enumera votaciones nominales en esta ventana, porque la aprobación por consentimiento unánime no incluye una votación nominal. El registro de este período no muestra nuevas acciones en el pleno sobre el S. 1525 ni el H.R. 3074.',
};

/** The old length line, spelled out, so a later edit to the constant shows up here. */
const OLD_LENGTH_LINE = '- 90 to 140 words per language. Plain text, no markdown, no headings.';

/** A Senate roll call on H.R. 10167. SYNTHETIC: the record has none; built to count a roll call as a line. */
const rollCall = (roll: number) => ({
  id: `s-119-2-${roll}`, chamber: 'senate', congress: 119, session: 2, roll, date: TODAY,
  question: 'On Passage of the Bill H.R. 10167', result: 'Bill Passed', bill: 'hr-10167-119',
  totals: { yea: 90, nay: 5, present: 0, notVoting: 5 }, source: 'https://www.senate.gov/',
});

/** A record line for the window. SYNTHETIC text; only its count matters here. */
const action = (n: number) => ({
  id: `u_synth${n}`, class: 'floor_action', vehicle: 'hr-10167-119', day: TODAY,
  record: { action_text: `Synthetic floor action number ${n}.`, action_code: null, action_type: 'Floor', source_system: 'Senate' },
});

function recordingClient(reply: unknown) {
  const prompts: string[] = [];
  return {
    prompts,
    messages: {
      create: async (args: { messages: { content: string }[] }) => {
        prompts.push(args.messages[0].content);
        return { content: [{ type: 'text', text: JSON.stringify(reply) }] };
      },
    },
  };
}

const promptFor = async (updates: Record<string, unknown>[], votes: Record<string, unknown>[] = [], reply: unknown = SHORT_REPLY) => {
  const client = recordingClient(reply);
  const revision = await generateStateSummary(
    client,
    'penny-production-and-cash-rounding',
    { updates, summary_revisions: [] },
    PENNY_STATUSES,
    [],
    PENNY_RECORDS,
    votes,
    votes.length ? votes.map((v) => String(v.id)) : [],
  );
  return { prompt: client.prompts[0], revision };
};

test.describe('a short record makes a short summary', () => {
  test('the old length line is what FULL_LENGTH_RULE still says, and the short rule says why it is short', () => {
    expect(FULL_LENGTH_RULE).toBe(OLD_LENGTH_LINE);
    expect(SHORT_RECORD_MAX_ITEMS).toBe(3);
    expect(SHORT_RECORD_LENGTH_RULE).toContain('40 to 90 words per language');
    expect(SHORT_RECORD_LENGTH_RULE).toContain('Never pad it with measures that did not move or with what did not happen');
  });

  test('the penny window (two actions) gets the short rule, and not the 90-to-140 line', async () => {
    const { prompt } = await promptFor(PENNY_WINDOW);
    expect(prompt).toContain(`\n${SHORT_RECORD_LENGTH_RULE}\n`);
    expect(prompt).not.toContain(OLD_LENGTH_LINE);
  });

  test('three lines are short; four keep the 90-to-140 line exactly as it was', async () => {
    const three = await promptFor([action(1), action(2), action(3)]);
    expect(three.prompt).toContain(SHORT_RECORD_LENGTH_RULE);
    const four = await promptFor([action(1), action(2), action(3), action(4)]);
    expect(four.prompt).toContain(`\n${OLD_LENGTH_LINE}\n`);
    expect(four.prompt).not.toContain(SHORT_RECORD_LENGTH_RULE);
  });

  test('roll calls count as lines: two actions and two roll calls keep the 90-to-140 line', async () => {
    const { prompt } = await promptFor(PENNY_WINDOW, [rollCall(901), rollCall(902)]);
    expect(prompt).toContain(`\n${OLD_LENGTH_LINE}\n`);
    expect(prompt).not.toContain(SHORT_RECORD_LENGTH_RULE);
  });

  test('the 43-word reply the real model gave passes the UNCHANGED gate and is stored', async () => {
    for (const lang of ['en', 'es'] as const) {
      expect(lintRevisionText(SHORT_REPLY[lang], lang, { groundedEvents: true, rollCallsOnRecord: 0 })).toEqual([]);
    }
    const { revision } = await promptFor(PENNY_WINDOW);
    expect(revision).not.toBeNull();
    expect(revision!.text).toEqual(SHORT_REPLY);
  });

  test('the padded reply the old line produced is still rejected, and nothing is stored', async () => {
    const { revision } = await promptFor(PENNY_WINDOW, [], PADDED_REPLY);
    expect(revision).toBeNull();
  });
});

test.describe('a rejected summary logs the sentence it was refused for', () => {
  test('refusedSentences finds the sentence for each quoted hit, once, and nothing for a failure with no quote', () => {
    const fails = [
      'en: absence claim "no other action" over a record that is not empty — the grounding holds a vote or action in this window, so "nothing happened" is false',
      'en: absence claim "no other action" over a record that is not empty',
      'en: empty',
    ];
    expect(refusedSentences(PADDED_REPLY.en, fails)).toEqual(['The record for this period shows no other action on the bill.']);
    expect(refusedSentences('', fails)).toEqual([]);
    const long = `${'word '.repeat(80)}no other action here.`;
    const [shown] = refusedSentences(long, fails);
    expect(shown.length).toBe(241);
    expect(shown.endsWith('…')).toBe(true);
  });

  test('the REJECTED line names the refused sentence in each language', async () => {
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await promptFor(PENNY_WINDOW, [], PADDED_REPLY);
    } finally {
      console.warn = warn;
    }
    const line = lines.find((l) => l.includes('REJECTED, the previous revision stands:')) ?? '';
    // The line still opens exactly as it did.
    expect(line.startsWith('  summary penny-production-and-cash-rounding REJECTED, the previous revision stands: en: absence claim "no other action"')).toBe(true);
    expect(line).toContain('— refused sentence(s): en: "The record for this period shows no other action on the bill."');
    expect(line).toContain('es: "El registro de este período no muestra otras acciones sobre el proyecto."');
  });
});

test.describe('the committed data', () => {
  test('every live question\'s prompt carries exactly one length rule, chosen by the size of its own window', async () => {
    const readJSON = (p: string) => JSON.parse(readFileSync(join(process.cwd(), p), 'utf8'));
    const moments = readJSON('data/moments.json');
    const bills = readJSON('data/bills.json');
    const store = readJSON('data/moment-updates.json');
    const votes = readJSON('data/votes.json');
    const plan = planSummaries({
      mode: 'nightly',
      moments,
      store: structuredClone(store),
      billBySlug: new Map(bills.map((b: { full_identifier: string }) => [b.full_identifier, b])),
      rollCalls: Array.isArray(votes?.rollCalls) ? votes.rollCalls : [],
      floorSignals: readJSON('data/floor-signals.json'),
      now: new Date(),
    });
    expect(plan.length).toBeGreaterThan(0);
    for (const p of plan) {
      const client = recordingClient(SHORT_REPLY);
      await generateStateSummary(client, p.momentId, structuredClone(store[p.momentId]), p.statuses, [], p.records, p.votes, p.rollCallsOnRecord);
      const prompt = client.prompts[0];
      const short = prompt.includes(SHORT_RECORD_LENGTH_RULE);
      const full = prompt.includes(`\n${OLD_LENGTH_LINE}\n`);
      expect(short !== full, p.momentId).toBe(true);
    }
  });
});
