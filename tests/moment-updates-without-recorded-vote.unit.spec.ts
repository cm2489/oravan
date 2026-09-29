import { expect, test } from '@playwright/test';
/*
 * "Where it stands" is told how a measure passed when no vote was recorded
 * (2026-09-29).
 *
 * THE FAILURE: the penny question's first summary was paid for and rejected
 * four nights running by the absence lint (Nightly bill sync, step "Collect
 * Moment updates"):
 *   - run 36260101319 (09-26): "no roll call", "no roll call recorded", "sin votación"
 *   - run 36340349799 (09-27): "No roll call vote", "No roll call vote was recorded", "No se registró"
 *   - run 36479913682 (09-28): "no tally", "no recorded", "no hay"
 *   - run 36619010910 (09-29): "no tally", "no hay"
 * The record in the window was H.R. 10167 passing the Senate "without
 * amendment by Unanimous Consent", and the prompt's RECORDED VOTES list read
 * "- no roll call recorded on these measures in this window". The gate is
 * right (a voice vote IS a vote); the prompt now hands the model the record's
 * own phrase and a rule. The gate itself is untouched, and the last test
 * below pins that "no tally" is still rejected.
 *
 * NARROWED the same day (independent check of #412): a line is built only for
 * the passage of the measure itself, and only on a question with no roll call
 * on record. S. 4668's "The committee substitute withdrawn by Voice Vote." —
 * on a bill with eleven roll calls in the window — no longer switches it on.
 *
 * Fixtures: the H.R. 10167 and S. 1525 update rows are data/moment-updates.json's,
 * ids and action sentences verbatim. ONE change, labelled where it is made:
 * the H.R. 10167 rows' `day` is moved to today's ET day, because
 * generateStateSummary reads its 14-day window off the real clock at import
 * time; the sentences are not touched. The committed-data tests read data/
 * and plan at the real clock too, so they compare like with like. ZERO network
 * and ZERO model calls: the client is a stub that records the prompt it was
 * handed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { etDay, lintRevisionText } from '../lib/moment-updates-gate.mjs';
import {
  WITHOUT_RECORDED_VOTE_RULE,
  generateStateSummary,
  planSummaries,
  withoutRecordedVoteLines,
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
const HOUSE_VOICE_PASSAGE = {
  id: 'u_8ad1a209', class: 'floor_action', vehicle: 'hr-10167-119', day: TODAY,
  record: { action_text: 'Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by voice vote.', action_code: '8000', action_type: 'Floor', source_system: 'Library of Congress' },
};
/** Its real day, 2026-08-07: outside any window this spec runs in, so it gets no line. */
const S1525_UC_PASSAGE = {
  id: 'u_97c1b067', class: 'floor_action', vehicle: 's-1525-119', day: '2026-08-07',
  record: { action_text: 'Passed Senate with an amendment by Unanimous Consent. (text of amendment in the nature of a substitute: CR S4586-4588)', action_code: null, action_type: 'Floor', source_system: 'Senate' },
};

/** data/moment-updates.json, penny-production-and-cash-rounding, as of 2026-09-29 (H.R. 10167 days moved to today, see header). */
const PENNY_UPDATES = [SENATE_UC_PASSAGE, SENATE_UC_DISCHARGE, HOUSE_VOICE_PASSAGE, S1525_UC_PASSAGE];

const PENNY_STATUSES = { 'hr-10167-119': 'passed_chamber', 's-1525-119': 'passed_chamber', 'hr-3074-119': 'passed_chamber' };

/** data/bills.json as of 2026-09-29: what planSummaries hands generateStateSummary as `records`. */
const PENNY_RECORDS = {
  'hr-10167-119': { lastActionText: 'Passed Senate without amendment by Unanimous Consent.', lastActionDate: '2026-09-28', billType: 'hr', statusBasisText: null },
  's-1525-119': { lastActionText: 'Held at the desk.', lastActionDate: '2026-08-10', billType: 's', statusBasisText: null },
  'hr-3074-119': { lastActionText: 'Received in the Senate and Read twice and referred to the Committee on Banking, Housing, and Urban Affairs.', lastActionDate: '2026-07-15', billType: 'hr', statusBasisText: null },
};

/** A Senate roll call on H.R. 10167. SYNTHETIC: the record has none; built to show a roll call switches the section off. */
const SYNTHETIC_ROLL = {
  id: 's-119-2-999', chamber: 'senate', congress: 119, session: 2, roll: 999, date: TODAY,
  question: 'On Passage of the Bill H.R. 10167', result: 'Bill Passed', bill: 'hr-10167-119',
  totals: { yea: 90, nay: 5, present: 0, notVoting: 5 }, source: 'https://www.senate.gov/',
};

/** A summary that says how the record says it passed, and nothing about a tally. Written for this test. */
const CLEAN = {
  en: 'On September 28, 2026, the Senate passed H.R. 10167 without amendment by unanimous consent. The House passed H.R. 10167 by voice vote on September 14, 2026.',
  es: 'El 28 de septiembre de 2026, el Senado aprobó la H.R. 10167 sin enmiendas por consentimiento unánime. La Cámara aprobó la H.R. 10167 por votación a viva voz el 14 de septiembre de 2026.',
};

/** The shape the 09-28 and 09-29 rejections name ("no tally", "no hay"). Written for this test; the model's own text was never logged. */
const NO_TALLY = {
  en: 'On September 28, 2026, the Senate passed H.R. 10167 without amendment by unanimous consent, with no tally.',
  es: 'El 28 de septiembre de 2026, el Senado aprobó la H.R. 10167 sin enmiendas por consentimiento unánime; no hay recuento de votos.',
};

/** Every string this change can add to a prompt. None may appear when no line is built. */
const NEW_TEXT = [WITHOUT_RECORDED_VOTE_RULE, 'PASSED WITHOUT A RECORDED VOTE', '- none in this window; see'];

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

const pennyPrompt = async (updates: Record<string, unknown>[], votes: Record<string, unknown>[] = [], onRecord: string[] | null = []) => {
  const client = recordingClient(JSON.stringify(CLEAN));
  const revision = await generateStateSummary(
    client,
    'penny-production-and-cash-rounding',
    { updates, summary_revisions: [] },
    PENNY_STATUSES,
    [],
    PENNY_RECORDS,
    votes,
    onRecord,
  );
  return { prompt: client.prompts[0], revision };
};

const readJSON = (p: string) => JSON.parse(readFileSync(join(process.cwd(), p), 'utf8'));

/** The committed data, planned at the real clock exactly as the nightly plans it, and every prompt built with a stub. */
async function committedPrompts() {
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
  const out: Record<string, string> = {};
  for (const p of plan) {
    const client = recordingClient(JSON.stringify(CLEAN));
    const contextRefs = (moments[p.momentId]?.context_refs ?? []).map((r: { url?: string }) => r?.url).filter(Boolean);
    await generateStateSummary(client, p.momentId, structuredClone(store[p.momentId]), p.statuses, contextRefs, p.records, p.votes, p.rollCallsOnRecord);
    out[p.momentId] = client.prompts[0];
  }
  return out;
}

test.describe('the record says how it passed', () => {
  test('penny: exactly the two passages of H.R. 10167 get a line; the discharge and the out-of-window S. 1525 passage do not', () => {
    expect(withoutRecordedVoteLines(PENNY_UPDATES.filter((u) => u.day === TODAY), { votes: [], onRecord: [] })).toEqual([
      `- ${TODAY} H.R. 10167: "Passed Senate without amendment by Unanimous Consent." → EN "by unanimous consent" / ES "por consentimiento unánime"`,
      `- ${TODAY} H.R. 10167: "Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by voice vote." → EN "by voice vote" / ES "por votación a viva voz"`,
    ]);
  });

  test('a passage by unanimous consent of S. 1525 would get its line when it is in the window', () => {
    expect(withoutRecordedVoteLines([{ ...S1525_UC_PASSAGE, day: TODAY }], { votes: [], onRecord: [] })).toEqual([
      `- ${TODAY} S. 1525: "Passed Senate with an amendment by Unanimous Consent. (text of amendment in the nature of a substitute: CR S4586-4588)" → EN "by unanimous consent" / ES "por consentimiento unánime"`,
    ]);
  });

  test('a non-passage voice vote on a vehicle with no roll call gets no line', () => {
    const nonPassage = [
      // data/moment-updates.json, paying-college-athletes, 2026-09-24 (day moved to today)
      { class: 'status_change', vehicle: 's-4668-119', day: TODAY, record: { action_text: 'The committee substitute withdrawn by Voice Vote.' } },
      { class: 'floor_action', vehicle: 'hr-10167-119', day: TODAY, record: { action_text: 'S.Amdt. 1 agreed to in Senate by Voice Vote.' } },
      { class: 'floor_action', vehicle: 'hr-10167-119', day: TODAY, record: { action_text: 'Motion to reconsider laid on the table Agreed to without objection.' } },
      SENATE_UC_DISCHARGE,
    ];
    expect(withoutRecordedVoteLines(nonPassage, { votes: [], onRecord: [] })).toEqual([]);
  });

  test('a vehicle with a roll call AND a voice-vote passage in the window gets no section', async () => {
    expect(withoutRecordedVoteLines([HOUSE_VOICE_PASSAGE], { votes: [SYNTHETIC_ROLL], onRecord: [SYNTHETIC_ROLL.id] })).toEqual([]);
    // Any roll call on record at any date switches it off, and so does an unknown count.
    expect(withoutRecordedVoteLines([HOUSE_VOICE_PASSAGE], { votes: [], onRecord: ['s-119-2-999'] })).toEqual([]);
    expect(withoutRecordedVoteLines([HOUSE_VOICE_PASSAGE], { votes: [], onRecord: null })).toEqual([]);
    const { prompt } = await pennyPrompt([HOUSE_VOICE_PASSAGE, SENATE_UC_PASSAGE], [SYNTHETIC_ROLL], [SYNTHETIC_ROLL.id]);
    for (const s of NEW_TEXT) expect(prompt).not.toContain(s);
  });

  test('the penny prompt carries the record phrase and the rule, and no longer says "no roll call recorded"', async () => {
    const { prompt, revision } = await pennyPrompt(PENNY_UPDATES);
    expect(prompt).toContain(WITHOUT_RECORDED_VOTE_RULE);
    expect(prompt).toContain('PASSED WITHOUT A RECORDED VOTE, LAST 14 DAYS');
    expect(prompt).toContain('"Passed Senate without amendment by Unanimous Consent." → EN "by unanimous consent" / ES "por consentimiento unánime"');
    expect(prompt).not.toContain('"Senate Committee on Banking, Housing, and Urban Affairs discharged by Unanimous Consent." →');
    expect(prompt).toContain('- none in this window; see PASSED WITHOUT A RECORDED VOTE below');
    expect(prompt).not.toContain('no roll call recorded on these measures');
    // The rule's substance, in the prompt's words.
    expect(WITHOUT_RECORDED_VOTE_RULE).toContain('say how the record says it passed');
    expect(WITHOUT_RECORDED_VOTE_RULE).toContain('Say nothing about a tally, a count or a roll call');
    expect(WITHOUT_RECORDED_VOTE_RULE).toContain('por consentimiento unánime');
    // The measure is described as the page describes it (#392, #382).
    expect(prompt).toContain('- H.R. 10167: EN "Passed both chambers" / ES "Aprobado por ambas cámaras"');

    // A summary that says "by unanimous consent" and nothing about a tally passes the unchanged gate.
    expect(revision).not.toBeNull();
    expect(revision!.text).toEqual(CLEAN);
    expect(revision!.grounded_in.vehicle_status_keys['hr-10167-119']).toBe('passed_both');
    expect(revision!.grounded_in.roll_calls_on_record).toEqual([]);
  });

  test('a question with no such passage gets exactly the prompt it got before', async () => {
    const { prompt } = await pennyPrompt([SENATE_UC_DISCHARGE]);
    for (const s of NEW_TEXT) expect(prompt).not.toContain(s);
    expect(prompt).toContain('- no roll call recorded on these measures in this window');
  });
});

test.describe('the committed data', () => {
  test('paying-college-athletes (S. 4668: roll calls on record, a voice-vote withdrawal) gets none of the new text', async () => {
    const prompts = await committedPrompts();
    expect(prompts['paying-college-athletes']).toBeTruthy();
    for (const s of NEW_TEXT) expect(prompts['paying-college-athletes']).not.toContain(s);
  });

  test('only a question with a passage without a recorded vote in its window gets the new text', async () => {
    const prompts = await committedPrompts();
    const withSection = Object.entries(prompts)
      .filter(([, p]) => p.includes('PASSED WITHOUT A RECORDED VOTE'))
      .map(([id]) => id);
    // On the committed data of 2026-09-29 that is penny alone (H.R. 10167's
    // Senate passage of 09-28 is in the window until 2026-10-12); after that,
    // no question. Never any other.
    expect(withSection.every((id) => id === 'penny-production-and-cash-rounding')).toBe(true);
    for (const [id, p] of Object.entries(prompts)) {
      if (withSection.includes(id)) continue;
      for (const s of NEW_TEXT) expect(p, id).not.toContain(s);
    }
  });
});

test.describe('the gate is unchanged', () => {
  test('"by unanimous consent" with no absence sentence passes, in both languages', () => {
    for (const lang of ['en', 'es'] as const) {
      expect(lintRevisionText(CLEAN[lang], lang, { groundedEvents: true, rollCallsOnRecord: 0 })).toEqual([]);
    }
  });

  test('"no tally" and "no hay" are still rejected, and the summary is not stored', async () => {
    const en = lintRevisionText(NO_TALLY.en, 'en', { groundedEvents: true, rollCallsOnRecord: 0 });
    const es = lintRevisionText(NO_TALLY.es, 'es', { groundedEvents: true, rollCallsOnRecord: 0 });
    expect(en.some((f: string) => f.startsWith('absence claim "no tally"'))).toBe(true);
    expect(es.some((f: string) => f.startsWith('absence claim "no hay"'))).toBe(true);

    const client = recordingClient(JSON.stringify(NO_TALLY));
    const revision = await generateStateSummary(
      client,
      'penny-production-and-cash-rounding',
      { updates: PENNY_UPDATES, summary_revisions: [] },
      PENNY_STATUSES,
      [],
      PENNY_RECORDS,
      [],
      [],
    );
    expect(revision).toBeNull();
  });
});
