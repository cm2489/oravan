import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner - same pattern as the other unit specs.
import bills from '../data/bills.json';
import { deriveJourney, journeyEnding, statusKeyFor } from '../lib/journey';
import { lintForbidden } from '../lib/moments-gate.mjs';
import { contentVersion } from '../lib/scriptcache';
import {
  buildScriptPrompt,
  passedBothReading,
  PROMPT_VERSION,
  stanceLine,
  type ScriptPromptInput,
} from '../lib/scriptprompt';
import type { Bill, Stance } from '../lib/types';

/*
 * A BILL BOTH CHAMBERS HAVE PASSED: THE SCRIPT ASKS FOR A PUBLIC STAND, NEVER
 * A VOTE (owner's pick 7 (a), 2026-09-29).
 *
 * The round-4 report: "Eleven bills have passed both chambers and now wait on
 * the president. Their call script still has a supporter ask the member to
 * 'vote for it', but the member already did." The owner's pick (a): "for
 * those bills, the script asks the member to publicly back or oppose it
 * before the president acts, and says where it stands. It needs a new script
 * version, so cached scripts get rewritten as people ask for them." His
 * reply: "7 a".
 *
 * The count on 2026-09-29 was twelve, not eleven, and only seven of them go
 * to the president next (lib/scriptprompt.ts, passedBothReading): the other
 * five get the same public-stand ask with no next step named, because the
 * page beside them names none either (page 1, rule 6).
 *
 * No model is called anywhere in this file: the prompt is a string, and every
 * assertion is about that string.
 *
 * The fixtures are data/bills.json's records as committed on 2026-09-29,
 * field for field, except `ai_summary`, which is a one-line stand-in.
 */

type Fixture = ScriptPromptInput['bill'];

/** Stage 'both': the Senate passed the House's text without amendment. */
const HR_4467: Fixture = {
  bill_type: 'hr',
  bill_number: 4467,
  title: 'Vicksburg National Military Park Boundary Modification Act',
  short_title: null,
  ai_summary: 'This bill would move two small parcels of park land to the state of Mississippi.',
  status: 'passed_chamber',
  last_action_date: '2026-09-24',
  last_action_text: 'Message on Senate action sent to the House.',
  status_basis_text: 'Passed Senate without amendment by Unanimous Consent. (consideration: CR S4882)',
  status_basis_date: '2026-09-22',
};

/** Stage 'second': the House passed a Senate bill, and its sentence gives no
 *  amendment clause, so the record does not say whether the versions match. */
const S_2403: Fixture = {
  bill_type: 's',
  bill_number: 2403,
  title: 'Retire through Ownership Act',
  short_title: null,
  ai_summary: 'This bill would change rules for employee-owned retirement plans.',
  status: 'passed_chamber',
  last_action_date: '2026-09-16',
  last_action_text: 'Motion to reconsider laid on the table Agreed to without objection.',
  status_basis_text:
    'Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by the Yeas and Nays: (2/3 required): 401 - 14 (Roll no. 314).',
  status_basis_date: '2026-09-16',
};

/** A concurrent resolution at stage 'second'. It never goes to the president. */
const SCONRES_29: Fixture = {
  bill_type: 'sconres',
  bill_number: 29,
  title:
    'A concurrent resolution authorizing the use of Emancipation Hall in the Capitol Visitor Center for an event to celebrate the birthday of King Kamehameha I.',
  short_title: null,
  ai_summary: 'This resolution lets a Capitol hall be used for a birthday celebration of King Kamehameha I.',
  status: 'passed_chamber',
  last_action_date: '2026-04-20',
  last_action_text: 'Motion to reconsider laid on the table Agreed to without objection.',
  status_basis_text:
    'Passed/agreed to in House: On agreeing to the resolution Agreed to without objection. (text: CR H2982)',
  status_basis_date: '2026-04-20',
};

/** One chamber has passed it; the Senate has only received it. */
const HR_7730: Fixture = {
  bill_type: 'hr',
  bill_number: 7730,
  title: 'Bankruptcy Threshold Adjustment Act of 2026',
  short_title: null,
  ai_summary: 'This bill would adjust the dollar thresholds used in bankruptcy cases.',
  status: 'passed_chamber',
  last_action_date: '2026-09-17',
  last_action_text: 'Received in the Senate.',
  status_basis_text: null,
  status_basis_date: null,
};

/** NOT a committed record: a proposed constitutional amendment at stage
 *  'both', which goes to the states, not the president. The corpus held no
 *  such record on 2026-09-29; this pins the stricter reading for when one
 *  arrives. */
const HJRES_ARTICLE_V: Fixture = {
  bill_type: 'hjres',
  bill_number: 9999,
  title: 'Proposing an amendment to the Constitution of the United States relating to a test fixture.',
  short_title: null,
  ai_summary: 'This resolution would propose a constitutional amendment.',
  status: 'passed_chamber',
  last_action_date: '2026-09-24',
  last_action_text: 'Message on Senate action sent to the House.',
  status_basis_text: 'Passed Senate without amendment by Yea-Nay Vote. 70 - 28.',
  status_basis_date: '2026-09-22',
};

const STANCE_ORDER: Stance[] = ['support', 'oppose', 'undecided'];

const EN_LANG =
  'Write the script in plain, warm English at an 8th-grade reading level. Use the placeholders [YOUR NAME] and [YOUR TOWN OR ZIP].';
const ES_LANG =
  'Write the script in natural, warm Latin American Spanish (tú form). Use the placeholders [TU NOMBRE] and [TU CIUDAD O CÓDIGO POSTAL].';

/** The concerned stance's shared body, with the one clause that differs. */
const concerned = (close: string) =>
  `The caller is CONCERNED about this bill and has not settled on support or opposition. The script must register that concern and name the ONE thing that worries them (grounded in the summary). Close with a self-contained statement that asks the office to log the caller's concern and ${close} - phrased as a statement or a request-to-record, NEVER as a question aimed at the staffer (for example, never end on 'could you let me know where the member stands?'). The staffer only tallies positions; the closing line must be fully meaningful on its own, with no spoken reply or callback required, since it may be left on a voicemail.`;

const NEVER =
  'NEVER ask the member to vote for or against this bill, and NEVER say or imply how the member voted, or whether the member voted at all.';

/** The lines every other stage carries, as they were before this change,
 *  written out in full so a drift in the shared template shows up here. */
const UNCHANGED: Record<Stance, string> = {
  support: 'The caller SUPPORTS this bill and urges the member to vote for it.',
  oppose: 'The caller OPPOSES this bill and urges the member to vote against it.',
  undecided: concerned("notes that the caller is watching for the office's position before deciding"),
};

const TO_PRESIDENT_WHERE =
  'Where the bill stands: both chambers of Congress have passed this bill, and it goes to the president next. The script must say so plainly.';

const TO_PRESIDENT: Record<Stance, string> = {
  support: `The caller SUPPORTS this bill and urges the member to publicly back it before the president acts on it. ${TO_PRESIDENT_WHERE} ${NEVER}`,
  oppose: `The caller OPPOSES this bill and urges the member to publicly oppose it before the president acts on it. ${TO_PRESIDENT_WHERE} ${NEVER}`,
  undecided: `${concerned('asks the member to state a public position on the bill before the president acts on it')} ${TO_PRESIDENT_WHERE} ${NEVER}`,
};

const NEXT_UNSTATED_WHERE =
  'Where the bill stands: both chambers of Congress have passed this bill. The script must say so plainly, and must not say what happens to the bill next (for example, never say that it goes to the president).';

const NEXT_UNSTATED: Record<Stance, string> = {
  support: `The caller SUPPORTS this bill and urges the member to publicly back it. ${NEXT_UNSTATED_WHERE} ${NEVER}`,
  oppose: `The caller OPPOSES this bill and urges the member to publicly oppose it. ${NEXT_UNSTATED_WHERE} ${NEVER}`,
  undecided: `${concerned('asks the member to state a public position on the bill')} ${NEXT_UNSTATED_WHERE} ${NEVER}`,
};

/** The stance line sits between the stage line's blank line and langLine. */
function stanceBlock(bill: Fixture, stanceText: string, langText: string): string {
  return `Current status: ${bill === HR_7730 ? 'Passed one chamber' : 'Passed both chambers'}\n\n${stanceText}\n\n${langText}`;
}

test.describe('a bill both chambers passed that goes to the president next', () => {
  test('H.R. 4467 reads to_president', () => {
    expect(statusKeyFor(HR_4467)).toBe('passed_both');
    expect(passedBothReading(HR_4467)).toBe('to_president');
    // The page beside the script prints the same thing.
    expect(deriveJourney(HR_4467).nowKey).toBe('nowPassedBoth');
  });

  for (const stance of STANCE_ORDER) {
    test(`English request, ${stance}: a public stand before the president acts, never a vote`, () => {
      const prompt = buildScriptPrompt({ bill: HR_4467, stance, lang: 'en' });
      expect(stanceLine(HR_4467, stance)).toBe(TO_PRESIDENT[stance]);
      expect(prompt).toContain(stanceBlock(HR_4467, TO_PRESIDENT[stance], EN_LANG));
      expect(prompt).not.toContain('urges the member to vote');
      expect(prompt).not.toContain("watching for the office's position before deciding");
    });

    test(`Spanish request, ${stance}: the same English input, only the language line asks for Spanish`, () => {
      const en = buildScriptPrompt({ bill: HR_4467, stance, lang: 'en' });
      const es = buildScriptPrompt({ bill: HR_4467, stance, lang: 'es' });
      expect(es).toContain(stanceBlock(HR_4467, TO_PRESIDENT[stance], ES_LANG));
      expect(es).not.toContain(EN_LANG);
      // Byte for byte, the two requests differ in that one line and nowhere else.
      expect(es.replace(ES_LANG, EN_LANG)).toBe(en);
    });
  }
});

test.describe('a bill both chambers passed whose next step the record does not name', () => {
  for (const bill of [S_2403, SCONRES_29]) {
    const id = `${bill.bill_type} ${bill.bill_number}`;

    test(`${id} reads next_unstated, the stepper's "doesn't say yet" sentence`, () => {
      expect(statusKeyFor(bill)).toBe('passed_both');
      expect(passedBothReading(bill)).toBe('next_unstated');
      expect(deriveJourney(bill).nowKey).toBe('nowPassedSecond');
    });

    for (const stance of STANCE_ORDER) {
      test(`${id}, ${stance}: the same public-stand ask, and no president, in both languages`, () => {
        const en = buildScriptPrompt({ bill, stance, lang: 'en' });
        const es = buildScriptPrompt({ bill, stance, lang: 'es' });
        expect(en).toContain(stanceBlock(bill, NEXT_UNSTATED[stance], EN_LANG));
        expect(es).toContain(stanceBlock(bill, NEXT_UNSTATED[stance], ES_LANG));
        expect(es.replace(ES_LANG, EN_LANG)).toBe(en);
        for (const prompt of [en, es]) {
          expect(prompt).not.toContain('goes to the president next');
          expect(prompt).not.toContain('before the president acts');
          expect(prompt).not.toContain('urges the member to vote');
        }
      });
    }
  }

  test('a proposed constitutional amendment at stage both goes to the states, so it names no president', () => {
    expect(journeyEnding(HJRES_ARTICLE_V.bill_type, HJRES_ARTICLE_V.title)).toBe('states');
    expect(statusKeyFor(HJRES_ARTICLE_V)).toBe('passed_both');
    expect(passedBothReading(HJRES_ARTICLE_V)).toBe('next_unstated');
    for (const stance of STANCE_ORDER) {
      expect(stanceLine(HJRES_ARTICLE_V, stance)).toBe(NEXT_UNSTATED[stance]);
    }
  });
});

test.describe('every other stage is unchanged', () => {
  test('a one-chamber bill keeps the vote ask, word for word, in both languages', () => {
    expect(statusKeyFor(HR_7730)).toBe('passed_chamber');
    expect(passedBothReading(HR_7730)).toBeNull();
    for (const stance of STANCE_ORDER) {
      const en = buildScriptPrompt({ bill: HR_7730, stance, lang: 'en' });
      const es = buildScriptPrompt({ bill: HR_7730, stance, lang: 'es' });
      expect(stanceLine(HR_7730, stance)).toBe(UNCHANGED[stance]);
      expect(en).toContain(stanceBlock(HR_7730, UNCHANGED[stance], EN_LANG));
      expect(es).toContain(stanceBlock(HR_7730, UNCHANGED[stance], ES_LANG));
      for (const prompt of [en, es]) {
        expect(prompt).not.toContain('publicly');
        expect(prompt).not.toContain('Where the bill stands');
      }
    }
  });

  test('corpus sweep: only passed_both changes, and the president is named only where the page names it', () => {
    let swept = 0;
    const readings = { to_president: 0, next_unstated: 0 };
    for (const raw of bills as unknown as Array<Fixture & Pick<Bill, 'congress_number'>>) {
      const id = `${raw.bill_type}-${raw.bill_number}-${raw.congress_number}`;
      const reading = passedBothReading(raw);
      // Only the passed_both label changes the ask.
      expect(reading !== null, id).toBe(statusKeyFor(raw) === 'passed_both');
      if (reading === null) {
        for (const stance of STANCE_ORDER) expect(stanceLine(raw, stance), id).toBe(UNCHANGED[stance]);
      } else {
        readings[reading]++;
        const nowKey = deriveJourney(raw).nowKey;
        const presidentNext = nowKey === 'nowPassedBoth' && journeyEnding(raw.bill_type, raw.title) === 'president';
        // The script says "goes to the president next" exactly when the
        // stepper beside it does, for a vehicle that really ends there.
        expect(reading === 'to_president', `${id}: ${nowKey}`).toBe(presidentNext);
        for (const stance of STANCE_ORDER) {
          const line = stanceLine(raw, stance);
          expect(line, id).toBe((reading === 'to_president' ? TO_PRESIDENT : NEXT_UNSTATED)[stance]);
          expect(line, id).not.toContain('urges the member to vote');
        }
      }
      swept++;
    }
    expect(swept).toBeGreaterThan(0);
    // Not asserted: how many of each. The corpus moves nightly, and a bill
    // that gets signed leaves this set. On 2026-09-29 it was 7 and 5.
    test.info().annotations.push({ type: 'passed_both readings', description: JSON.stringify(readings) });
  });
});

test.describe('the wording', () => {
  test('support and oppose are one sentence with the verb swapped, in both readings', () => {
    for (const lines of [TO_PRESIDENT, NEXT_UNSTATED]) {
      expect(lines.support.replace('SUPPORTS', 'OPPOSES').replace('publicly back it', 'publicly oppose it')).toBe(
        lines.oppose
      );
    }
  });

  test('the concerned line leans neither way: it asks for a public position, not for backing or opposing', () => {
    for (const lines of [TO_PRESIDENT, NEXT_UNSTATED]) {
      expect(lines.undecided).toContain('asks the member to state a public position on the bill');
      expect(lines.undecided).not.toMatch(/publicly (back|oppose)/);
      expect(lines.undecided).toContain('has not settled on support or opposition');
    }
  });

  test('no line names or implies a member vote, and "the president" is lowercase', () => {
    for (const lines of [TO_PRESIDENT, NEXT_UNSTATED]) {
      for (const stance of STANCE_ORDER) {
        expect(lines[stance]).toContain(NEVER);
        expect(lines[stance]).not.toMatch(/\bvoted (for|against|yes|no)\b/i);
        expect(lines[stance]).not.toMatch(/\bPresident\b/);
      }
    }
  });

  test('the Big Questions forbidden-vocabulary lint finds nothing in the new lines', () => {
    // Rule 3 has no gate on call-script prompts; this borrows the one it has.
    for (const lines of [TO_PRESIDENT, NEXT_UNSTATED]) {
      for (const stance of STANCE_ORDER) expect(lintForbidden(lines[stance], 'en'), stance).toEqual([]);
    }
  });
});

test.describe('the prompt version', () => {
  test('bumped to 3, so every cached script is a clean miss and is rewritten on request', () => {
    expect(PROMPT_VERSION).toBe('3');
    // Recompute the key the way lib/scriptcache.ts builds it, under 2 and 3:
    // the live key is the '3' one, so a script cached under '2' is never read.
    const key = (version: string, bill: Fixture) =>
      createHash('sha256')
        .update(
          [version, bill.ai_summary ?? bill.title, bill.status, bill.last_action_date]
            .map((part) => (part === null ? '~' : `${part.length}:${part}`))
            .join('|')
        )
        .digest('hex')
        .slice(0, 12);
    for (const bill of [HR_4467, HR_7730]) {
      expect(contentVersion(bill)).toBe(key('3', bill));
      expect(contentVersion(bill)).not.toBe(key('2', bill));
    }
  });
});
