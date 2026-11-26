import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner - same pattern as the other unit specs.
import { buildNominationScriptPrompt, NOMINATION_AUDIENCES } from '../lib/nomination-script';
import { buildScriptPrompt, SPANISH_ASK_RULE, STANCES, type ScriptPromptInput } from '../lib/scriptprompt';

/*
 * THE SPANISH CALL SCRIPT ASKS THE MEMBER, NEVER THE STAFF (2026-11-25).
 *
 * An outside review of the Spanish edition read a script that asked the
 * staffer on the line to vote: "Les pido a ustedes en su oficina que voten a
 * favor". The fix is one rule on the Spanish language line of both prompts
 * (lib/scriptprompt.ts SPANISH_ASK_RULE). These tests pin the PROMPT TEXT
 * only. No model is called here, and no generated Spanish script was read to
 * check the fix: that is a live spot-check after deploy.
 */

type Fixture = ScriptPromptInput['bill'];

/** A committee-stage bill: the plain "vote for it" stance lines apply. */
const BILL: Fixture = {
  bill_type: 'hr',
  bill_number: 1787,
  title: 'Roberto Clemente Commemorative Coin Act',
  short_title: null,
  ai_summary: 'This bill would mint three commemorative coins in 2027.',
  status: 'committee',
  last_action_date: '2026-03-03',
  last_action_text: 'Referred to the House Committee on Financial Services.',
  status_basis_text: null,
  status_basis_date: null,
} as Fixture;

const NOMINATION = {
  citation: 'PN123-119',
  nominee_description: 'Jane Doe, of Ohio, to be a Member of a test board, vice John Roe.',
  organization: 'Test Board',
  status: 'exec_calendar' as const,
  last_action_text: 'Placed on Senate Executive Calendar. Calendar No. 838.',
};

test.describe('the Spanish ask rule', () => {
  test('asks for the member in the third person and rules out asking the staff to vote', () => {
    expect(SPANISH_ASK_RULE).toContain('the ask is made of the member, in the third person');
    expect(SPANISH_ASK_RULE).toContain('the staff do not vote');
    expect(SPANISH_ASK_RULE).toContain('never "les pido a ustedes que voten"');
    expect(SPANISH_ASK_RULE).toContain('Le pido a quien me representa en el Congreso que');
  });

  test('its example names no chamber title, so it cannot contradict the chamber-neutral rule', () => {
    // The bill script is read to a Representative's office and both Senators'
    // offices; the prompt forbids these titles. The example must not use one.
    for (const title of ['senador', 'senadora', 'representante', 'congresista']) {
      expect(SPANISH_ASK_RULE.toLowerCase()).not.toContain(title);
    }
  });

  test('retires "constituyente" and gives the placeholder the Spanish prompt already uses', () => {
    expect(SPANISH_ASK_RULE).toContain('Never call the caller a "constituyente"');
    expect(SPANISH_ASK_RULE).toContain('vivo en [TU CIUDAD O CÓDIGO POSTAL]');
  });
});

test.describe('the bill prompt', () => {
  for (const stance of STANCES) {
    test(`${stance}: the Spanish request carries the rule; the English one does not`, () => {
      const es = buildScriptPrompt({ bill: BILL, stance, lang: 'es' });
      const en = buildScriptPrompt({ bill: BILL, stance, lang: 'en' });
      expect(es).toContain(SPANISH_ASK_RULE);
      expect(en).not.toContain(SPANISH_ASK_RULE);
      expect(en).not.toContain('constituyente');
      // The rule rides on the language line itself, so the English input
      // block (bill, summary, stage, stance line) is untouched.
      expect(es).toContain(
        `Write the script in natural, warm Latin American Spanish (tú form). Use the placeholders [TU NOMBRE] and [TU CIUDAD O CÓDIGO POSTAL]. ${SPANISH_ASK_RULE}`
      );
    });
  }
});

test.describe('the nomination prompt', () => {
  for (const audience of NOMINATION_AUDIENCES) {
    for (const stance of STANCES) {
      test(`${audience}, ${stance}: the Spanish request carries the same rule`, () => {
        const es = buildNominationScriptPrompt({ nomination: NOMINATION, stance, audience, lang: 'es' });
        const en = buildNominationScriptPrompt({ nomination: NOMINATION, stance, audience, lang: 'en' });
        expect(es).toContain(SPANISH_ASK_RULE);
        expect(en).not.toContain(SPANISH_ASK_RULE);
      });
    }
  }
});
