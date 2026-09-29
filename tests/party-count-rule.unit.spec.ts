import { expect, test } from '@playwright/test';
import { lintForbidden } from '../lib/moments-gate.mjs';
import {
  NEVER_NAME_A_PARTY,
  PARTY_COUNT_EXAMPLES,
  PARTY_COUNT_SHAPES,
  partyCountsPassLint,
  partyRule,
  partyTotalsPromptText,
} from '../lib/party-count-rule.mjs';
import { draftPrompt, enumLeaks, groundFor, recordLines, recordedVoteLines } from '../scripts/moment-draft.mjs';
import { generateStateSummary, partyTallyFor, voteGroundingLine } from '../scripts/moment-updates.mjs';

/*
 * THE WRITERS' PARTY RULE (2026-09-29, the owner's card l12, delegated: "You
 * handle the rule change. This is not that big of a deal to me, I just need
 * it to work."). lib/party-count-rule.mjs is the one source of the party rule
 * in scripts/moment-updates.mjs (one-liners and "Where it stands") and
 * scripts/moment-draft.mjs (Big Question first drafts): a party may appear
 * only inside a count on a recorded vote, copied from that roll call's
 * `totalsByParty`.
 *
 * WHAT THESE TESTS CAN AND CANNOT SAY. Whether the rule is OFFERED depends on
 * the rule-3 lint on this tree: main's lint refuses every party name, PR #363
 * lets a party count on a recorded vote through. So nothing here pins which
 * way the probe answers — that would break the day #363 merges. It pins that
 * the prompt and the lint AGREE, whichever way that is, and it pins both
 * renderings by passing the switch explicitly. No model is called.
 */

const T_184 = {
  D: { yea: 44, nay: 1, present: 0, notVoting: 0 },
  I: { yea: 2, nay: 0, present: 0, notVoting: 0 },
  R: { yea: 4, nay: 47, present: 0, notVoting: 2 },
};
/** Senate roll 184 on H.Con.Res. 86, 2026-06-23, as data/votes.json holds it. */
const ROLL_184 = {
  id: 's-119-2-184', chamber: 'senate', congress: 119, session: 2, roll: 184, date: '2026-06-23',
  question: 'On the Concurrent Resolution H.Con.Res. 86', result: 'Concurrent Resolution Agreed to', bill: 'hconres-86-119',
  totals: { yea: 50, nay: 48, present: 0, notVoting: 2 }, totalsByParty: T_184,
  source: 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00184.xml',
};
const BY_PARTY_184 =
  "by party, the record's own count: Republicans (R) Yeas 4, Nays 47, Present 0, Not Voting 2; " +
  'Democrats (D) Yeas 44, Nays 1, Present 0, Not Voting 0; independents (I) Yeas 2, Nays 0, Present 0, Not Voting 0';

test.describe('the rule and the lint agree', () => {
  test('the probe is exactly "every example passes the rule-3 lint on this tree"', () => {
    const passes = (['en', 'es'] as const).every((lang) =>
      PARTY_COUNT_EXAMPLES[lang].every((s) => lintForbidden(`${s}.`, lang).length === 0)
    );
    expect(partyCountsPassLint()).toBe(passes);
  });

  test('the probe asks about the prompt\'s own shapes, numbers filled in', () => {
    for (const lang of ['en', 'es'] as const) {
      expect(PARTY_COUNT_EXAMPLES[lang]).toEqual(PARTY_COUNT_SHAPES[lang].map((s) => s.replace(/\bN\b/g, '4').replace(/\bM\b/g, '43')));
    }
  });

  test('every example is a COUNT on a recorded vote: a number, a party noun and a position', () => {
    for (const s of [...PARTY_COUNT_EXAMPLES.en, ...PARTY_COUNT_EXAMPLES.es]) {
      expect(s).toMatch(/\d/);
      expect(s).toMatch(/republican|democrat|demócrata/i);
      expect(s).toMatch(/voted yes|yea|nay|votaron a favor|a favor|en contra/i);
    }
  });

  test('refused on this tree, or allowed: either way the other shapes still fail the lint', () => {
    // Whatever #363 changes, these stay refused, so the rule's "never" list is
    // backed by the gate, not only by the prompt.
    for (const [lang, s] of [
      ['en', 'Republicans voted no.'],
      ['en', 'Democrats want the war powers vote.'],
      ['en', 'The GOP voted 49-4.'],
      ['es', 'Los republicanos votaron en contra.'],
    ] as const) {
      expect(lintForbidden(s, lang), s).not.toEqual([]);
    }
  });
});

test.describe('partyRule', () => {
  test('no figures in the prompt, or a lint that refuses: the old rule, word for word', () => {
    expect(NEVER_NAME_A_PARTY).toBe('- Never name a political party, in either language.');
    expect(partyRule({ figures: '', allowed: true })).toBe(NEVER_NAME_A_PARTY);
    expect(partyRule({ figures: 'the figures above', allowed: false })).toBe(NEVER_NAME_A_PARTY);
  });

  test('allowed: one exception, the lint-accepted shapes, and nothing else about a party', () => {
    const rule = partyRule({ figures: 'the figures above', allowed: true });
    expect(rule).toContain('Never name a political party, with ONE exception');
    expect(rule).toContain('copied exactly from the figures above');
    // The shapes, with letters for the numbers: no sample number to copy.
    for (const s of [...PARTY_COUNT_SHAPES.en, ...PARTY_COUNT_SHAPES.es]) expect(rule).toContain(s);
    expect(rule).not.toMatch(/\d/);
    expect(rule).toContain('"Republicans voted no" is refused');
    expect(rule).toContain('never with a motive, stance, strategy or reaction');
    expect(rule).toContain('"GOP"');
    expect(rule).toContain('A count those figures do not give is not written.');
  });
});

test.describe('partyTotalsPromptText', () => {
  test('the record\'s numbers, largest group first, every position printed', () => {
    expect(partyTotalsPromptText(T_184)).toBe(BY_PARTY_184);
  });

  test('a letter with no name, a party at zero, or nothing at all: left out', () => {
    expect(partyTotalsPromptText({ ID: { yea: 1, nay: 0, present: 0, notVoting: 0 } })).toBe('');
    expect(partyTotalsPromptText({ R: { yea: 0, nay: 0, present: 0, notVoting: 0 } })).toBe('');
    expect(partyTotalsPromptText(undefined)).toBe('');
    expect(partyTotalsPromptText({})).toBe('');
  });
});

test.describe('scripts/moment-updates.mjs', () => {
  test('the grounding line gains the count by party only when it may be used', () => {
    const base =
      '- 2026-06-23 · Senate roll call no. 184 · H. Con. Res. 86 · question: "On the Concurrent Resolution H.Con.Res. 86" · result: "Concurrent Resolution Agreed to" · Yeas 50, Nays 48, Present 0, Not Voting 2';
    expect(voteGroundingLine(ROLL_184, { partyCounts: false })).toBe(base);
    expect(voteGroundingLine(ROLL_184, { partyCounts: true })).toBe(`${base} · ${BY_PARTY_184}`);
    // A roll call without the field reads exactly as before, either way.
    const { totalsByParty: _drop, ...bare } = ROLL_184;
    void _drop;
    expect(voteGroundingLine(bare, { partyCounts: true })).toBe(base);
  });

  test('the one-liner looks the roll call up by chamber, number, measure and day', () => {
    const vote = { vehicle: 'hconres-86-119', day: '2026-06-23', record: { roll_call: { chamber: 'senate', number: 184 } } };
    expect(partyTallyFor(vote, [ROLL_184])).toEqual({ tally_by_party: BY_PARTY_184 });
    // Same roll number, another session's date: not this roll call.
    expect(partyTallyFor({ ...vote, day: '2025-06-23' }, [ROLL_184])).toEqual({});
    expect(partyTallyFor({ ...vote, vehicle: 'hconres-89-119' }, [ROLL_184])).toEqual({});
    expect(partyTallyFor(vote, [])).toEqual({});
  });

  test('"Where it stands": the prompt\'s rule and its figures follow the lint, together', async () => {
    const prompts: string[] = [];
    const client = {
      messages: {
        create: async (args: { messages: { content: string }[] }) => {
          prompts.push(args.messages[0].content);
          return { content: [{ type: 'text', text: JSON.stringify({ en: 'x', es: 'x' }) }] };
        },
      },
    };
    await generateStateSummary(client, 'war-powers-test', { updates: [], summary_revisions: [] }, { 'hconres-86-119': 'passed_chamber' }, [], {}, [ROLL_184]);
    const prompt = prompts[0];
    expect(prompt).toContain(voteGroundingLine(ROLL_184));
    if (partyCountsPassLint()) {
      expect(prompt).toContain('Never name a political party, with ONE exception');
      expect(prompt).toContain(BY_PARTY_184);
    } else {
      expect(prompt).toContain(NEVER_NAME_A_PARTY);
      expect(prompt).not.toContain('by party');
      expect(prompt).not.toContain('with ONE exception');
    }
  });
});

test.describe('scripts/moment-draft.mjs', () => {
  const CANDIDATE = {
    slug: 'hconres-86-119',
    citation: 'H.Con.Res. 86',
    headline: 'Resolution on the use of armed forces',
    status: 'passed_chamber',
    lastActionDate: '2026-06-23',
    floorCalendar: false,
    floorChamber: null,
    urgency: 0.5,
    tier: 'neutral',
    outlets: 3,
    leans: ['unrated'],
    url: 'https://www.congress.gov/bill/119th-congress/house-concurrent-resolution/86',
  };
  const BILL = {
    full_identifier: 'hconres-86-119',
    title: 'A concurrent resolution directing the removal of United States Armed Forces from hostilities.',
    last_action_text: 'Resolution agreed to in Senate without amendment by Yea-Nay Vote. 50 - 48. Record Vote Number: 184.',
  };

  test('while a party count is refused, the record block and the rule are what they were', () => {
    const before = groundFor(CANDIDATE, BILL, null, [], { partyCounts: false });
    const g = groundFor(CANDIDATE, BILL, null, [ROLL_184], { partyCounts: false });
    expect(recordedVoteLines(g)).toEqual([]);
    expect(recordLines(g)).toEqual(recordLines(before));
    const prompt = draftPrompt(g);
    expect(prompt).toContain(NEVER_NAME_A_PARTY);
    expect(prompt).not.toContain('by party');
  });

  test('once allowed, the record block carries the vote and its count by party, and the rule points at it', () => {
    const g = groundFor(CANDIDATE, BILL, null, [ROLL_184], { partyCounts: true });
    expect(recordedVoteLines(g)).toEqual([
      `recorded vote, 2026-06-23: Senate roll call no. 184 · question "On the Concurrent Resolution H.Con.Res. 86" · result "Concurrent Resolution Agreed to" · Yeas 50, Nays 48, Present 0, Not Voting 2 · ${BY_PARTY_184}`,
    ]);
    const prompt = draftPrompt(g);
    expect(prompt).toContain(`- ${recordedVoteLines(g)[0]}`);
    expect(prompt).toContain('copied exactly from the "by party" figures of that recorded vote in THE RECORD above');
    // The closed record's enum guard still passes with the vote lines in it.
    expect(enumLeaks(g)).toEqual([]);
  });

  test('allowed but no recorded vote on file: no figures, so still no party', () => {
    const g = groundFor(CANDIDATE, BILL, null, [], { partyCounts: true });
    expect(draftPrompt(g)).toContain(NEVER_NAME_A_PARTY);
  });

  test('at most three votes, newest first, only this measure\'s', () => {
    const older = [1, 2, 3, 4].map((n) => ({ ...ROLL_184, id: `s-119-2-${n}`, roll: n, date: `2026-06-0${n}` }));
    const other = { ...ROLL_184, bill: 'hconres-89-119', date: '2026-09-24', roll: 244 };
    const g = groundFor(CANDIDATE, BILL, null, [...older, ROLL_184, other], { partyCounts: true });
    expect(g.votes.map((v) => v.roll)).toEqual([184, 4, 3]);
  });
});
