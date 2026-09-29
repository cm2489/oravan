import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner - same pattern as the other unit specs.
import bills from '../data/bills.json';
import { statusKeyFor, type StatusKeyBill } from '../lib/journey';
import { contentVersion } from '../lib/scriptcache';
import { buildScriptPrompt, scriptStage, type ScriptPromptInput } from '../lib/scriptprompt';
import type { Bill, StatusLabelKey } from '../lib/types';
import en from '../messages/en.json';

/*
 * THE CALL-SCRIPT WRITER IS TOLD EACH BILL'S REAL STAGE (2026-09-29).
 *
 * lib/scriptprompt.ts used to write `Current status: ${bill.status}`, the raw
 * stored enum. A measure both chambers have passed is still stored as
 * `passed_chamber` (the stored status set has no value for the second
 * chamber's passage), so the script writer was told "passed_chamber" about
 * H.R. 4467 while the bill page beside the script said "Passed both
 * chambers". The line now carries statusKeyFor(bill)'s English label from
 * messages/en.json `bills.status.*`, the same stage the page prints.
 *
 * No model is called anywhere in this file: the prompt is a string, and every
 * assertion is about that string.
 *
 * The three fixtures are data/bills.json's records as committed on
 * 2026-09-29, field for field, except `ai_summary`, which is a one-line stand-
 * in (the stage line is what is pinned here, and the real summaries run to
 * three paragraphs).
 */

type Fixture = ScriptPromptInput['bill'];

/** H.R. 4467: passed the House, then the Senate passed it without amendment
 *  by unanimous consent. Both chambers have passed it. */
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

/** H.R. 7730: the House passed it and the Senate has only received it. One
 *  chamber really has passed it, so "Passed one chamber" stays. */
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

/** H.Con.Res. 86: agreed to by the House, then by the Senate without
 *  amendment. It goes to no president. Settled, so its page shows the record
 *  where a call panel would stand (CLAUDE.md rule 6), but app/api/script has
 *  no settled gate for bills and would still write a script if asked, so the
 *  prompt must not call it one chamber's. */
const HCONRES_86: Fixture = {
  bill_type: 'hconres',
  bill_number: 86,
  title:
    'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove United States Armed Forces from hostilities with Iran.',
  short_title: null,
  ai_summary: 'This resolution tells the president to remove U.S. forces from hostilities with Iran.',
  status: 'passed_chamber',
  last_action_date: '2026-06-24',
  last_action_text: 'Message on Senate action sent to the House.',
  status_basis_text:
    'Resolution agreed to in Senate without amendment by Yea-Nay Vote. 50 - 48. Record Vote Number: 184. (consideration: CR S3039-3040)',
  status_basis_date: '2026-06-23',
};

const LABELS = en.bills.status as Record<StatusLabelKey, string>;

/** The prompt's one `Current status:` line, or null when it is missing. */
function stageLine(prompt: string): string | null {
  const lines = prompt.split('\n').filter((l) => l.startsWith('Current status: '));
  return lines.length === 1 ? lines[0].slice('Current status: '.length) : null;
}

test.describe('the stage line, pinned', () => {
  test('a bill both chambers passed: the writer is told "Passed both chambers"', () => {
    const prompt = buildScriptPrompt({ bill: HR_4467, stance: 'support', lang: 'en' });
    expect(prompt).toContain(
      [
        'Bill: H.R. 4467 — Vicksburg National Military Park Boundary Modification Act',
        'Plain-language summary: This bill would move two small parcels of park land to the state of Mississippi.',
        'Current status: Passed both chambers',
        '',
        'The caller SUPPORTS this bill and urges the member to vote for it.',
      ].join('\n')
    );
    // The raw enum is gone from the prompt entirely, not just from that line.
    expect(prompt).not.toContain('passed_chamber');
    expect(prompt).not.toContain('Passed one chamber');
  });

  test('a bill one chamber passed: the writer is told "Passed one chamber"', () => {
    const prompt = buildScriptPrompt({ bill: HR_7730, stance: 'oppose', lang: 'en' });
    expect(prompt).toContain(
      [
        'Bill: H.R. 7730 — Bankruptcy Threshold Adjustment Act of 2026',
        'Plain-language summary: This bill would adjust the dollar thresholds used in bankruptcy cases.',
        'Current status: Passed one chamber',
        '',
        'The caller OPPOSES this bill and urges the member to vote against it.',
      ].join('\n')
    );
    expect(prompt).not.toContain('passed_chamber');
    expect(prompt).not.toContain('Passed both chambers');
  });

  test('a concurrent resolution both chambers agreed to: "Adopted by both chambers"', () => {
    const prompt = buildScriptPrompt({ bill: HCONRES_86, stance: 'undecided', lang: 'en' });
    expect(stageLine(prompt)).toBe('Adopted by both chambers');
    expect(prompt).not.toContain('passed_chamber');
  });

  test('the Spanish request carries the same English stage line, like the rest of its input', () => {
    // lib/scriptprompt.ts's module note: the model is always given English
    // input and only langLine asks for Spanish output.
    for (const bill of [HR_4467, HR_7730, HCONRES_86]) {
      const enPrompt = buildScriptPrompt({ bill, stance: 'support', lang: 'en' });
      const esPrompt = buildScriptPrompt({ bill, stance: 'support', lang: 'es' });
      expect(stageLine(esPrompt), `${bill.bill_type} ${bill.bill_number}`).toBe(stageLine(enPrompt));
    }
  });

  test('the words are messages/en.json bills.status.*, read through statusKeyFor, not a second copy', () => {
    expect(statusKeyFor(HR_4467)).toBe('passed_both');
    expect(statusKeyFor(HR_7730)).toBe('passed_chamber');
    expect(statusKeyFor(HCONRES_86)).toBe('adopted');
    for (const bill of [HR_4467, HR_7730, HCONRES_86]) {
      expect(scriptStage(bill)).toBe(LABELS[statusKeyFor(bill)]);
    }
  });
});

test.describe('the cache key did not move', () => {
  test('the stage is not key material, so this change regenerates nothing early', () => {
    // Deliberate (lib/scriptcache.ts, "THE STAGE LINE READS MORE THAN THIS KEY
    // HOLDS"): the key holds the status and the last-action date, not the
    // stage. Two records that differ ONLY in what statusKeyFor reads beyond
    // those share a key, and PROMPT_VERSION was not bumped, so every script
    // cached before this change stays keyed where it was and expires on the
    // 24-hour TTL. If the stage is ever added to the key, this assertion is
    // where that decision (and its one-day full regeneration) gets made.
    const asOneChamber: Fixture = { ...HR_4467, status_basis_text: null, last_action_text: 'Received in the Senate.' };
    expect(statusKeyFor(asOneChamber)).toBe('passed_chamber');
    expect(contentVersion(HR_4467)).toBe(contentVersion(asOneChamber));
  });
});

test.describe('corpus sweep', () => {
  test('every committed bill hands the writer a label from bills.status.*, never a raw enum', () => {
    const labels = new Set(Object.values(LABELS));
    let swept = 0;
    for (const raw of bills as unknown as Array<Fixture & Pick<Bill, 'congress_number'>>) {
      const id = `${raw.bill_type}-${raw.bill_number}-${raw.congress_number}`;
      const line = stageLine(buildScriptPrompt({ bill: raw, stance: 'support', lang: 'en' }));
      expect(line, `${id}: exactly one stage line`).not.toBeNull();
      expect(labels.has(line as string), `${id}: "${line}" is a bills.status label`).toBe(true);
      expect(line, `${id}: no raw enum`).not.toMatch(/_/);
      // Exact per-bill equality where the reading has no clock. A floor
      // placement's label turns on the 14-day window, and computing it twice
      // could straddle midnight UTC, so those are held to the label set above.
      if (raw.status !== 'floor_vote') {
        expect(line, id).toBe(LABELS[statusKeyFor(raw as StatusKeyBill)]);
      }
      swept++;
    }
    expect(swept).toBeGreaterThan(0);
  });
});
