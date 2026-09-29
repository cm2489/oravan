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
 * Fixtures: the three H.R. 10167 update rows are data/moment-updates.json's,
 * ids and action sentences verbatim. ONE change, labelled where it is made:
 * their `day` is moved to today's ET day, because generateStateSummary reads
 * its 14-day window off the real clock at import time; the sentences are not
 * touched. ZERO network and ZERO model calls: the client is a stub that
 * records the prompt it was handed.
 */
import { etDay, lintRevisionText } from '../lib/moment-updates-gate.mjs';
import {
  WITHOUT_RECORDED_VOTE_RULE,
  generateStateSummary,
  withoutRecordedVoteLines,
} from '../scripts/moment-updates.mjs';

const TODAY = etDay(new Date());

/** data/moment-updates.json, penny-production-and-cash-rounding, as of 2026-09-29 (day moved to today, see header). */
const PENNY_UPDATES = [
  {
    id: 'u_a1f9a417', class: 'floor_action', vehicle: 'hr-10167-119', day: TODAY,
    record: { action_text: 'Passed Senate without amendment by Unanimous Consent.', action_code: null, action_type: 'Floor', source_system: 'Senate' },
  },
  {
    id: 'u_10792eb6', class: 'floor_action', vehicle: 'hr-10167-119', day: TODAY,
    record: { action_text: 'Senate Committee on Banking, Housing, and Urban Affairs discharged by Unanimous Consent.', action_code: null, action_type: 'Discharge', source_system: 'Senate' },
  },
  {
    id: 'u_8ad1a209', class: 'floor_action', vehicle: 'hr-10167-119', day: TODAY,
    record: { action_text: 'Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by voice vote.', action_code: '8000', action_type: 'Floor', source_system: 'Library of Congress' },
  },
];

const PENNY_STATUSES = { 'hr-10167-119': 'passed_chamber', 's-1525-119': 'passed_chamber', 'hr-3074-119': 'passed_chamber' };

/** data/bills.json as of 2026-09-29: what planSummaries hands generateStateSummary as `records`. */
const PENNY_RECORDS = {
  'hr-10167-119': { lastActionText: 'Passed Senate without amendment by Unanimous Consent.', lastActionDate: '2026-09-28', billType: 'hr', statusBasisText: null },
  's-1525-119': { lastActionText: 'Held at the desk.', lastActionDate: '2026-08-10', billType: 's', statusBasisText: null },
  'hr-3074-119': { lastActionText: 'Received in the Senate and Read twice and referred to the Committee on Banking, Housing, and Urban Affairs.', lastActionDate: '2026-07-15', billType: 'hr', statusBasisText: null },
};

/** A summary that says how the record says it passed, and nothing about a tally. Written for this test. */
const CLEAN = {
  en: 'On September 28, 2026, the Senate passed H.R. 10167 without amendment by unanimous consent, the same day its Banking Committee was discharged by unanimous consent. The House passed H.R. 10167 by voice vote on September 14, 2026.',
  es: 'El 28 de septiembre de 2026, el Senado aprobó la H.R. 10167 sin enmiendas por consentimiento unánime, el mismo día en que su Comité de Banca fue relevado por consentimiento unánime. La Cámara aprobó la H.R. 10167 por votación a viva voz el 14 de septiembre de 2026.',
};

/** The shape the 09-28 and 09-29 rejections name ("no tally", "no hay"). Written for this test; the model's own text was never logged. */
const NO_TALLY = {
  en: 'On September 28, 2026, the Senate passed H.R. 10167 without amendment by unanimous consent, with no tally.',
  es: 'El 28 de septiembre de 2026, el Senado aprobó la H.R. 10167 sin enmiendas por consentimiento unánime; no hay recuento de votos.',
};

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

test.describe('the record says how it passed', () => {
  test('each voice vote and unanimous-consent action gets the record sentence verbatim and its phrase', () => {
    expect(withoutRecordedVoteLines(PENNY_UPDATES)).toEqual([
      `- ${TODAY} H.R. 10167: "Passed Senate without amendment by Unanimous Consent." → EN "by unanimous consent" / ES "por consentimiento unánime"`,
      `- ${TODAY} H.R. 10167: "Senate Committee on Banking, Housing, and Urban Affairs discharged by Unanimous Consent." → EN "by unanimous consent" / ES "por consentimiento unánime"`,
      `- ${TODAY} H.R. 10167: "Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by voice vote." → EN "by voice vote" / ES "por votación a viva voz"`,
    ]);
  });

  test('a recorded vote, a press cluster and a referral get no line', () => {
    expect(
      withoutRecordedVoteLines([
        { class: 'floor_action', vehicle: 'hconres-89-119', day: TODAY, record: { action_text: 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.' } },
        { class: 'press_cluster', vehicle: 'hr-10167-119', day: TODAY, source: { outlet_names: ['A'] } },
        { class: 'floor_action', vehicle: 'hr-10167-119', day: TODAY, record: { action_text: 'Received in the Senate and Read twice and referred to the Committee on Banking, Housing, and Urban Affairs.' } },
      ]),
    ).toEqual([]);
  });

  test('the penny prompt carries the record phrase and the rule, and no longer says "no roll call recorded"', async () => {
    const client = recordingClient(JSON.stringify(CLEAN));
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
    const prompt = client.prompts[0];
    expect(prompt).toContain(WITHOUT_RECORDED_VOTE_RULE);
    expect(prompt).toContain('TAKEN WITHOUT A RECORDED VOTE, LAST 14 DAYS');
    expect(prompt).toContain('"Passed Senate without amendment by Unanimous Consent." → EN "by unanimous consent" / ES "por consentimiento unánime"');
    expect(prompt).toContain('- none in this window; see TAKEN WITHOUT A RECORDED VOTE below');
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

  test('a question with no such action gets exactly the prompt it got before', async () => {
    const client = recordingClient(JSON.stringify(CLEAN));
    await generateStateSummary(
      client,
      'penny-production-and-cash-rounding',
      { updates: [PENNY_UPDATES[0]].map((u) => ({ ...u, record: { ...u.record, action_text: 'Received in the Senate and Read twice and referred to the Committee on Banking, Housing, and Urban Affairs.' } })), summary_revisions: [] },
      PENNY_STATUSES,
      [],
      PENNY_RECORDS,
      [],
      [],
    );
    expect(client.prompts[0]).not.toContain(WITHOUT_RECORDED_VOTE_RULE);
    expect(client.prompts[0]).not.toContain('TAKEN WITHOUT A RECORDED VOTE');
    expect(client.prompts[0]).toContain('- no roll call recorded on these measures in this window');
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
