import { expect, test } from '@playwright/test';
import bills from '../data/bills.json';
import { statusKeyFor as statusKeyForTs, type StatusKeyBill } from '../lib/journey';
import { lintRevisionText } from '../lib/moment-updates-gate.mjs';
import { INTERNAL_ENUM_TOKENS, enumLeaks, groundFor, recordLines } from '../scripts/moment-draft.mjs';
import { billLabel } from '../scripts/moment-updates-map.mjs';
import { generateStateSummary, planSummaries, recordStatusKey, recordStatusPhrase } from '../scripts/moment-updates.mjs';
import { buildBillIndex, buildT3Prompt, formatT3Candidate, scoreCandidates } from '../scripts/newsdesk-match.mjs';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * THE AI WRITERS READ EACH BILL'S REAL STAGE (2026-09-29).
 *
 * #368 taught the site to read a `passed_chamber` record two more ways:
 * `adopted` (a concurrent resolution both chambers agreed to in one form) and
 * `passed_both` (the second chamber passed it). The bill page and its chip
 * read them through lib/journey.ts's statusKeyFor, which takes the whole bill,
 * and the Big Questions card's status line reads the same passage readers
 * (lib/moment-status.mjs). The script-side copy in
 * scripts/moment-candidates.mjs reads them only when it is handed the bill as
 * its 5th argument, and the three scripts that hand a status phrase to a model
 * called it with four:
 *
 *   scripts/moment-updates.mjs   the "Where it stands" prompt. It told the
 *                                model H.Con.Res. 86 "Passed one chamber",
 *                                and the 2026-09-26 revision on
 *                                /questions/iran-war-powers says so.
 *   scripts/moment-draft.mjs     the draft's record block ("where it stands").
 *   scripts/newsdesk-match.mjs   the t3 candidate line ("status: …").
 *
 * Every fixture below is verbatim from data/bills.json as committed on
 * 2026-09-29, except that H.Con.Res. 93's row carries no status basis at all
 * there; its two nulls stand in for the missing fields, which every reader
 * treats the same way. The corpus sweeps at the bottom compare each writer
 * with the TS original over whatever the corpus holds on the day they run.
 */

/** H.Con.Res. 86: the House agreed to it 215–208 on 2026-06-03 (Roll no. 199),
 *  the Senate agreed to it without amendment 50–48 on 2026-06-23 (Record Vote
 *  184), and "Message on Senate action sent to the House." was written over
 *  that on 2026-06-24. */
const HCONRES_86 = {
  full_identifier: 'hconres-86-119',
  congress_number: 119,
  bill_type: 'hconres',
  bill_number: 86,
  title: 'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove United States Armed Forces from hostilities with Iran.',
  status: 'passed_chamber' as const,
  last_action_date: '2026-06-24',
  last_action_text: 'Message on Senate action sent to the House.',
  status_basis_text:
    'Resolution agreed to in Senate without amendment by Yea-Nay Vote. 50 - 48. Record Vote Number: 184. (consideration: CR S3039-3040)',
  status_basis_date: '2026-06-23',
};

/** H.R. 4467: passed the House, then the Senate passed it without amendment
 *  on 2026-09-22. Both chambers passed it; it goes to the president next. */
const HR_4467 = {
  full_identifier: 'hr-4467-119',
  congress_number: 119,
  bill_type: 'hr',
  bill_number: 4467,
  title: 'Vicksburg National Military Park Boundary Modification Act',
  status: 'passed_chamber' as const,
  last_action_date: '2026-09-24',
  last_action_text: 'Message on Senate action sent to the House.',
  status_basis_text: 'Passed Senate without amendment by Unanimous Consent. (consideration: CR S4882)',
  status_basis_date: '2026-09-22',
};

/** H.Con.Res. 93: the House passed it, and the Senate has only received it.
 *  One chamber really has passed it, so "Passed one chamber" stays. */
const HCONRES_93 = {
  full_identifier: 'hconres-93-119',
  congress_number: 119,
  bill_type: 'hconres',
  bill_number: 93,
  title: 'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove United States Armed Forces from hostilities with Iran.',
  status: 'passed_chamber' as const,
  last_action_date: '2026-09-16',
  last_action_text: 'Received in the Senate and referred to the Committee on Foreign Relations.',
  status_basis_text: null,
  status_basis_date: null,
};

type Row = typeof HCONRES_86 | typeof HR_4467 | typeof HCONRES_93;

/** What planSummaries puts in its `records` map for one bill. */
const recordOf = (b: Row) => ({
  lastActionText: b.last_action_text,
  lastActionDate: b.last_action_date,
  billType: b.bill_type,
  statusBasisText: b.status_basis_text,
});

/** One candidate in buildReport()'s shape, as scripts/moment-watch.mjs hands
 *  it to groundFor beside its bill row. */
const candidateOf = (b: Row) => ({
  slug: b.full_identifier,
  citation: `${b.bill_type} ${b.bill_number}`,
  headline: null,
  status: b.status,
  lastActionDate: b.last_action_date,
  floorCalendar: false,
  floorChamber: null,
  tier: 'neutral',
  outlets: 2,
  leans: [],
  url: `https://www.congress.gov/bill/119th-congress/${b.full_identifier}`,
});

/** The real messages/*.json vocabulary, as scripts/moment-watch.mjs passes it. */
const STATUS_PHRASES = { en: en.bills.status, es: es.bills.status };

const ADOPTED = { en: 'Adopted by both chambers', es: 'Adoptado por ambas cámaras' };
const PASSED_BOTH = { en: 'Passed both chambers', es: 'Aprobado por ambas cámaras' };
const PASSED_ONE = { en: 'Passed one chamber', es: 'Aprobado por una cámara' };

test.describe('the messages the writers quote are the ones the page prints', () => {
  test('bills.status carries the two passage readings in both languages', () => {
    expect(en.bills.status.adopted).toBe(ADOPTED.en);
    expect(es.bills.status.adopted).toBe(ADOPTED.es);
    expect(en.bills.status.passed_both).toBe(PASSED_BOTH.en);
    expect(es.bills.status.passed_both).toBe(PASSED_BOTH.es);
    expect(en.bills.status.passed_chamber).toBe(PASSED_ONE.en);
    expect(es.bills.status.passed_chamber).toBe(PASSED_ONE.es);
  });
});

test.describe('scripts/moment-updates.mjs · the "Where it stands" prompt', () => {
  test('H.Con.Res. 86 is "Adopted by both chambers", in both languages', () => {
    expect(recordStatusKey('passed_chamber', recordOf(HCONRES_86))).toBe('adopted');
    expect(recordStatusPhrase('passed_chamber', recordOf(HCONRES_86), 'en')).toBe(ADOPTED.en);
    expect(recordStatusPhrase('passed_chamber', recordOf(HCONRES_86), 'es')).toBe(ADOPTED.es);
  });

  test('H.R. 4467, which the Senate passed without amendment, is "Passed both chambers"', () => {
    expect(recordStatusKey('passed_chamber', recordOf(HR_4467))).toBe('passed_both');
    expect(recordStatusPhrase('passed_chamber', recordOf(HR_4467), 'en')).toBe(PASSED_BOTH.en);
    expect(recordStatusPhrase('passed_chamber', recordOf(HR_4467), 'es')).toBe(PASSED_BOTH.es);
  });

  test('a measure only one chamber has passed keeps "Passed one chamber"', () => {
    expect(recordStatusPhrase('passed_chamber', recordOf(HCONRES_93), 'en')).toBe(PASSED_ONE.en);
    expect(recordStatusPhrase('passed_chamber', recordOf(HCONRES_93), 'es')).toBe(PASSED_ONE.es);
  });

  test('a record without the bill type reads exactly as before (an old caller is not broken)', () => {
    const bare = { lastActionText: HCONRES_86.last_action_text, lastActionDate: HCONRES_86.last_action_date };
    expect(recordStatusKey('passed_chamber', bare)).toBe('passed_chamber');
  });

  test('both phrases survive the summary lint, so a model that uses them is not rejected for it', () => {
    for (const lang of ['en', 'es'] as const) {
      expect(lintRevisionText(recordStatusPhrase('passed_chamber', recordOf(HCONRES_86), lang), lang)).toEqual([]);
      expect(lintRevisionText(recordStatusPhrase('passed_chamber', recordOf(HR_4467), lang), lang)).toEqual([]);
    }
  });

  test('planSummaries carries the bill type and status basis into its records, and the prompt says "Adopted by both chambers"', async () => {
    const billBySlug = new Map<string, Row>([
      [HCONRES_86.full_identifier, HCONRES_86],
      [HCONRES_93.full_identifier, HCONRES_93],
    ]);
    const plan = planSummaries({
      mode: 'nightly',
      moments: {
        'iran-war-powers': {
          status: 'live',
          vehicles: [{ slug: HCONRES_86.full_identifier }, { slug: HCONRES_93.full_identifier }],
        },
      },
      // No revision yet, so the nightly plans one; nothing is sent anywhere.
      store: { 'iran-war-powers': { updates: [], summary_revisions: [] } },
      billBySlug,
      now: new Date('2026-09-29T14:15:00Z'),
    });
    expect(plan).toHaveLength(1);
    const [p] = plan;
    // What a revision is grounded in (and what the refresh decision diffs) is
    // the RAW status, unchanged by this fix.
    expect(p.statuses).toEqual({ 'hconres-86-119': 'passed_chamber', 'hconres-93-119': 'passed_chamber' });
    expect(p.records['hconres-86-119']).toEqual(recordOf(HCONRES_86));

    // A fake client that records the prompt. No model is called.
    const prompts: string[] = [];
    const capturing = {
      messages: {
        create: async (args: { messages: { content: string }[] }) => {
          prompts.push(args.messages[0].content);
          return { content: [{ type: 'text', text: JSON.stringify({ en: 'x', es: 'x' }) }] };
        },
      },
    };
    await generateStateSummary(capturing, 'iran-war-powers', { updates: [], summary_revisions: [] }, p.statuses, [], p.records, p.votes, p.rollCallsOnRecord);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`- ${billLabel('hconres-86-119')}: EN "${ADOPTED.en}" / ES "${ADOPTED.es}"`);
    expect(prompts[0]).toContain(`- ${billLabel('hconres-93-119')}: EN "${PASSED_ONE.en}" / ES "${PASSED_ONE.es}"`);
    expect(prompts[0]).not.toContain(`- ${billLabel('hconres-86-119')}: EN "${PASSED_ONE.en}"`);
  });
});

test.describe('scripts/moment-draft.mjs · the draft\'s record block', () => {
  test('H.Con.Res. 86 reads "Adopted by both chambers" in both languages, and the block leaks no enum', () => {
    const g = groundFor(candidateOf(HCONRES_86), HCONRES_86, STATUS_PHRASES, [], { partyCounts: false });
    expect(g.statusKey).toBe('adopted');
    expect(g.statusEn).toBe(ADOPTED.en);
    expect(g.statusEs).toBe(ADOPTED.es);
    expect(recordLines(g)).toContain(`where it stands: EN "${ADOPTED.en}" / ES "${ADOPTED.es}"`);
    expect(enumLeaks(g)).toEqual([]);
  });

  test('H.R. 4467 reads "Passed both chambers", and the block leaks no enum', () => {
    const g = groundFor(candidateOf(HR_4467), HR_4467, STATUS_PHRASES, [], { partyCounts: false });
    expect(g.statusKey).toBe('passed_both');
    expect(recordLines(g)).toContain(`where it stands: EN "${PASSED_BOTH.en}" / ES "${PASSED_BOTH.es}"`);
    expect(enumLeaks(g)).toEqual([]);
  });

  test('a measure only one chamber has passed keeps "Passed one chamber"', () => {
    const g = groundFor(candidateOf(HCONRES_93), HCONRES_93, STATUS_PHRASES, [], { partyCounts: false });
    expect(g.statusKey).toBe('passed_chamber');
    expect(g.statusEn).toBe(PASSED_ONE.en);
  });

  test('with no bill row, the key reads exactly as before', () => {
    expect(groundFor(candidateOf(HCONRES_86), undefined, STATUS_PHRASES, [], { partyCounts: false }).statusKey).toBe('passed_chamber');
  });

  test('the enum guard catches the new snake_case key but not the English word "adopted"', () => {
    expect(INTERNAL_ENUM_TOKENS).toContain('passed_both');
    expect(INTERNAL_ENUM_TOKENS).not.toContain('adopted');
  });
});

test.describe('scripts/newsdesk-match.mjs · the t3 candidate line', () => {
  const index = buildBillIndex([HCONRES_86, HR_4467, HCONRES_93]);
  const bySlug = new Map(index.map((e) => [e.slug, e]));

  test('the index keeps the raw status and adds the key', () => {
    expect(bySlug.get('hconres-86-119')).toMatchObject({ status: 'passed_chamber', statusKey: 'adopted' });
    expect(bySlug.get('hr-4467-119')).toMatchObject({ status: 'passed_chamber', statusKey: 'passed_both' });
    expect(bySlug.get('hconres-93-119')).toMatchObject({ status: 'passed_chamber', statusKey: 'passed_chamber' });
  });

  test('the prompt t3 reads says each measure\'s real stage', () => {
    const headline = 'War powers resolution on Iran hostilities';
    const candidates = scoreCandidates(headline, index);
    const slugs = candidates.map((c: { slug: string }) => c.slug);
    expect(slugs).toEqual(expect.arrayContaining(['hconres-86-119', 'hconres-93-119']));
    const prompt = buildT3Prompt([{ title: headline, candidates }], { today: '2026-09-29' });
    expect(prompt).toContain('hconres-86-119 = Directing the President');
    expect(prompt).toContain('[latest action 2026-06-24; status: adopted by both chambers]');
    expect(prompt).toContain('[latest action 2026-09-16; status: passed one chamber]');
    expect(prompt).not.toContain('[latest action 2026-06-24; status: passed one chamber]');
  });

  test('H.R. 4467\'s line says "passed both chambers"', () => {
    expect(formatT3Candidate({ ...bySlug.get('hr-4467-119'), floor: null })).toBe(
      'hr-4467-119 = Vicksburg National Military Park Boundary Modification Act [latest action 2026-09-24; status: passed both chambers]',
    );
  });

  test('every floor key prints the same words the raw floor_vote always printed', () => {
    for (const statusKey of ['floor_vote', 'floor_vote_stale', 'floor_activity']) {
      expect(formatT3Candidate({ slug: 'x', title: 'X', lastActionDate: '2026-01-01', status: 'floor_vote', statusKey })).toBe(
        'x = X [latest action 2026-01-01; status: floor action on record]',
      );
    }
  });
});

/*
 * THE CORPUS SWEEPS: each writer against the TS original, over every record
 * the corpus holds today. The two whose clock cannot be injected (groundFor
 * and buildBillIndex read Date.now()) are swept over `passed_chamber` records
 * only, where the key has no clock, so a run that straddles midnight UTC
 * cannot make them disagree with themselves.
 */
test.describe('corpus sweeps: every writer agrees with lib/journey.ts statusKeyFor', () => {
  const corpus = bills as unknown as (StatusKeyBill & Record<string, unknown>)[];
  const passed = corpus.filter((b) => b.status === 'passed_chamber');

  test('the corpus still holds the shapes this file is about', () => {
    const keys = new Set(passed.map((b) => statusKeyForTs(b)));
    expect(keys.has('adopted')).toBe(true);
    expect(keys.has('passed_both')).toBe(true);
    expect(keys.has('passed_chamber')).toBe(true);
  });

  test('moment-updates: recordStatusKey over every record, at one instant', () => {
    const now = Date.now();
    const off = corpus.filter((b) => {
      const rec = {
        lastActionText: (b.last_action_text as string | null) ?? null,
        lastActionDate: (b.last_action_date as string | null) ?? null,
        billType: (b.bill_type as string | null) ?? null,
        statusBasisText: (b.status_basis_text as string | null) ?? null,
      };
      return recordStatusKey(b.status, rec, now) !== statusKeyForTs(b, now);
    });
    expect(off.map((b) => b.full_identifier)).toEqual([]);
  });

  test('moment-draft: groundFor over every passed_chamber record', () => {
    const off = passed.filter((b) => {
      const c = { slug: b.full_identifier, citation: 'x', status: b.status, lastActionDate: b.last_action_date, tier: 'none', outlets: 0 };
      return groundFor(c, b, null, [], { partyCounts: false }).statusKey !== statusKeyForTs(b);
    });
    expect(off.map((b) => b.full_identifier)).toEqual([]);
  });

  test('newsdesk-match: buildBillIndex over every passed_chamber record', () => {
    const index = buildBillIndex(passed);
    const bySlug = new Map(index.map((e) => [e.slug, e.statusKey]));
    const off = passed.filter((b) => bySlug.has(b.full_identifier as string) && bySlug.get(b.full_identifier as string) !== statusKeyForTs(b));
    expect(off.map((b) => b.full_identifier)).toEqual([]);
  });
});
