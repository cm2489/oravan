import { expect, test } from '@playwright/test';
/*
 * A PROMPT NEVER USES A WORD ITS OWN VOCABULARY RULE FORBIDS (2026-10-06).
 *
 * THE FAILURE: the Big Question summary prompt opened "Write a nonpartisan
 * 'Where it stands' summary of one congressional fight", and eight lines later
 * told the model never to write "fight". On 2026-09-30 a summary was rejected
 * for forbidden vocabulary "fight". The same prompt, and the Big Question draft
 * prompt, also ended an instruction with "stop", another listed word.
 *
 * THE CHECK: every prompt that carries the vocabulary list is built here with
 * neutral fixture records, the one line that states the list is set aside, and
 * the rest is read by the gate's own lint (lintForbidden, lib/moments-gate.mjs)
 * in both languages. The lint is used rather than a raw word search on
 * purpose: a quoted span is exempt there exactly as it is in a stored line, and
 * that is what keeps Oravan's editorial law in the prompts word for word (it is
 * quoted, and it says "Oravan's voice stops").
 *
 * ZERO network and ZERO model calls: each client is a stub that records the
 * prompt it is handed.
 */
import { FORBIDDEN, lintForbidden } from '../lib/moments-gate.mjs';
import { etDay } from '../lib/moment-updates-gate.mjs';
import { VOCABULARY_RULE, buildStructurePrompt } from '../scripts/bill-decode.mjs';
import { draftPrompt, groundFor } from '../scripts/moment-draft.mjs';
import {
  FULL_LENGTH_RULE,
  SHORT_RECORD_LENGTH_RULE,
  WITHOUT_RECORDED_VOTE_RULE,
  decodeUpdates,
  generateStateSummary,
} from '../scripts/moment-updates.mjs';

const TODAY = etDay(new Date());
const LANGS = ['en', 'es'] as const;

/** The listed English words, party names aside: a line naming every one of them is the list itself. */
const LIST_WORDS = FORBIDDEN.en.filter(({ word }) => word !== 'party name');

const isListLine = (line: string) => LIST_WORDS.every(({ re }) => re.test(line));

/** The prompt without the line that states the list. Exactly one such line is required. */
function instructionText(prompt: string, listLine?: string): string {
  const lines = prompt.split('\n');
  const listed = listLine ? lines.filter((l) => l === listLine) : lines.filter(isListLine);
  expect(listed, 'the prompt states the vocabulary list on exactly one line').toHaveLength(1);
  return lines.filter((l) => l !== listed[0]).join('\n');
}

/** Each listed word the lint finds in the instruction text, as "lang: word". */
function listedWordsIn(text: string): string[] {
  return LANGS.flatMap((lang) => lintForbidden(text, lang).map((word: string) => `${lang}: ${word}`));
}

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

/* Neutral fixture records (no listed word in them), so any hit is the prompt's own wording. */
const UC_PASSAGE = {
  id: 'u_fixture1', class: 'floor_action', vehicle: 'hr-10167-119', day: TODAY,
  record: { action_text: 'Passed Senate without amendment by Unanimous Consent.', action_code: null, action_type: 'Floor', source_system: 'Senate' },
};
const actions = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `u_fixture_a${i}`, class: 'floor_action', vehicle: 'hr-10167-119', day: TODAY,
    record: { action_text: `Fixture floor action number ${i}.`, action_code: null, action_type: 'Floor', source_system: 'House' },
  }));
const PRESS_ONLY = {
  id: 'u_fixture_p', class: 'press_cluster', vehicle: 'hr-10167-119', day: TODAY,
  source: { outlet_names: ['Fixture Wire', 'Fixture Daily'] },
};
const ROLL = {
  id: 'h-119-2-901', chamber: 'house', congress: 119, session: 2, roll: 901, date: TODAY,
  question: 'On Passage', result: 'Passed', bill: 'hr-10167-119',
  totals: { yea: 230, nay: 190, present: 0, notVoting: 12 }, source: 'https://clerk.house.gov/',
};
const STATUSES = { 'hr-10167-119': 'passed_chamber' };
const RECORDS = {
  'hr-10167-119': { lastActionText: 'Passed Senate without amendment by Unanimous Consent.', lastActionDate: TODAY, billType: 'hr', statusBasisText: null },
};

/** Every branch of the summary prompt's instructions: short and full length, empty and non-empty record, with and without a passage taken without a roll call. */
const SUMMARY_CASES: { name: string; updates: Record<string, unknown>[]; votes: Record<string, unknown>[]; onRecord: string[] | null; carries: string[] }[] = [
  { name: 'a passage without a recorded vote (short)', updates: [UC_PASSAGE], votes: [], onRecord: [], carries: [SHORT_RECORD_LENGTH_RULE, WITHOUT_RECORDED_VOTE_RULE, 'The record below is NOT empty'] },
  { name: 'a recorded vote and four actions (full length)', updates: actions(4), votes: [ROLL], onRecord: [ROLL.id], carries: [FULL_LENGTH_RULE, 'The record below is NOT empty'] },
  { name: 'press coverage only (no record in the window)', updates: [PRESS_ONLY], votes: [], onRecord: null, carries: ['Do not write sentences about what did not happen'] },
];

test.describe('no prompt uses a word its own vocabulary rule forbids', () => {
  for (const c of SUMMARY_CASES) {
    test(`the "Where it stands" summary prompt: ${c.name}`, async () => {
      const client = recordingClient({ en: 'Fixture.', es: 'Fixture.' });
      await generateStateSummary(client, 'fixture-question', { updates: c.updates, summary_revisions: [] }, STATUSES, [], RECORDS, c.votes, c.onRecord);
      expect(client.prompts).toHaveLength(1);
      // The branch this case is here to cover really is in the prompt.
      for (const rule of c.carries) expect(client.prompts[0]).toContain(rule);
      expect(listedWordsIn(instructionText(client.prompts[0]))).toEqual([]);
    });
  }

  test('the summary prompt names the question plainly, not as a fight', async () => {
    const client = recordingClient({ en: 'Fixture.', es: 'Fixture.' });
    await generateStateSummary(client, 'fixture-question', { updates: [UC_PASSAGE], summary_revisions: [] }, STATUSES, [], RECORDS, [], []);
    expect(client.prompts[0].split('\n')[0]).toBe(
      'Write a nonpartisan "Where it stands" summary of one question before Congress, in English and Spanish, for an everyday US resident reading at an 8th-grade level.'
    );
  });

  test('the one-line update decode prompt', async () => {
    const client = recordingClient([]);
    await decodeUpdates(client, [
      { class: 'floor_action', vehicle: 'hr-10167-119', day: TODAY, record: UC_PASSAGE.record },
      { class: 'press_cluster', vehicle: 'hr-10167-119', day: TODAY, source: PRESS_ONLY.source },
    ]);
    expect(client.prompts).toHaveLength(1);
    expect(listedWordsIn(instructionText(client.prompts[0]))).toEqual([]);
  });

  test('the Big Question draft prompt, with and without a recorded vote', () => {
    const candidate = {
      slug: 's-3172-119', citation: 'S. 3172', headline: 'Bill would repeal two long-standing US sanctions laws on Syria',
      status: 'floor_vote', lastActionDate: TODAY, floorCalendar: true, floorChamber: 'senate', urgency: 0.9, tier: 'neutral',
      outlets: 5, leans: ['unrated'], partisanLeans: 0, articles: 5, url: 'https://www.congress.gov/bill/119th-congress/senate-bill/3172',
    };
    const bill = {
      full_identifier: 's-3172-119', title: 'A bill to repeal certain Acts that impose sanctions upon Syria.',
      last_action_text: 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 501.',
    };
    const roll = {
      id: 's-119-2-184', chamber: 'senate', congress: 119, session: 2, roll: 184, date: TODAY, question: 'On Passage of the Bill S. 3172',
      result: 'Bill Passed', bill: 's-3172-119', totals: { yea: 60, nay: 38, present: 0, notVoting: 2 }, source: 'https://www.senate.gov/',
    };
    for (const g of [groundFor(candidate, bill, null), groundFor(candidate, bill, null, [roll])]) {
      expect(listedWordsIn(instructionText(draftPrompt(g)))).toEqual([]);
    }
  });

  test('the bill decode structure prompt', () => {
    const prompt = buildStructurePrompt({ bill_type: 'hconres', bill_number: 89, title: 'A fixture title' }, 'A plain summary.');
    expect(listedWordsIn(instructionText(prompt, VOCABULARY_RULE))).toEqual([]);
  });

  test('the check itself: an instruction that uses a listed word is caught, and a quoted one is not', () => {
    const prompt = ['Write about one congressional fight.', '- Never use advocacy verbs (fight, resist, stop, save, defend, block) or crisis/attack/scheme framing.', 'The law: "our voice stops".'].join('\n');
    expect(listedWordsIn(instructionText(prompt))).toEqual(['en: fight']);
  });
});
