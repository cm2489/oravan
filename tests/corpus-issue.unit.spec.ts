import { expect, test } from '@playwright/test';
import {
  CLEAN_MARKER,
  cleanComment,
  findingSeen,
  needsCleanComment,
  reportFindings,
  unseenFindings,
} from '../lib/corpus-issue.mjs';
import { formatIssueBody } from '../scripts/check-scaffold-corpus.mjs';

/*
 * lib/corpus-issue.mjs — the corpus issues comment only on what is new
 * (owner, 2026-11-23, card `emails`: "the robot threads go quiet").
 * The report texts below are the real shapes the two sweeps write, copied
 * from issues #268 and #398 as they stood on 2026-11-23.
 */

const SJRES_124 = 'The motion to discharge fell when the point of order was well taken.';
const SJRES_98 =
  'Point of order that the measure is not entitled to expedited procedures under 50 U.S.C. 1546(a) raised against the measure agreed to in Senate by Yea-Nay Vote. 50 - 50. Record Vote Number: 9.';

const journeyReport = (date: string, corpus: number, items: Array<[string, string]>) =>
  [
    `The nightly sync of ${date} read ${items.length} floor sentence(s) that no matcher in \`lib/floor-text.mjs\` understands yet.`,
    '',
    '**Nothing on the site is claiming anything about these bills.**',
    '',
    ...items.map(([slug, text]) => `- **${slug}** — no matcher places this sentence in a chamber (\`floorActionChamber\`):\n  > ${text}`),
    '',
    `Corpus: ${corpus} \`floor_vote\` records swept.`,
  ].join('\n');

test.describe('reportFindings', () => {
  test('a journey report: one finding per bullet, slug and quoted sentence', () => {
    expect(reportFindings(journeyReport('2026-11-22', 638, [['sjres-124-119', SJRES_124]]))).toEqual([
      { slug: 'sjres-124-119', quote: SJRES_124, line: null },
    ]);
  });

  test('a scaffold report, from the sweep\'s own formatter, including a quote-less problem line', () => {
    const body = formatIssueBody(
      {
        counts: { floorVote: 638, activityOnly: 42, claimFree: 1, settledOutcome: 13 },
        missed: [{ slug: 'sjres-98-119', status: 'floor_vote', text: SJRES_98 }],
        overfired: [],
        problems: ['The two exemptions (claim-free 1, settled 13) now cover at least as many bills as the population they carve out of (12) — check.'],
      },
      '2026-11-22'
    );
    const found = reportFindings(body);
    expect(found[0]).toEqual({ slug: 'sjres-98-119', quote: SJRES_98, line: null });
    // The problem line is keyed with its numbers blanked.
    expect(found[1].quote).toBeNull();
    expect(found[1].line).toContain('claim-free #, settled #');
  });

  test('an error body with no bullet is keyed on its quote; a fallback body on its first line, links and numbers blanked', () => {
    expect(reportFindings('The sweep could not run on 2026-11-23:\n\n> Unexpected token } in JSON\n\nThis is not a clean result.')).toEqual([
      { slug: null, quote: 'Unexpected token } in JSON', line: null },
    ]);
    const fallback = (run: string) =>
      `The nightly Moment-scaffold floor-action sweep returned no usable verdict (got ""). See the run log: https://github.com/cm2489/oravan/actions/runs/${run}\n`;
    expect(reportFindings(fallback('111'))).toEqual(reportFindings(fallback('222')));
  });
});

test.describe('unseenFindings — a repeat night posts nothing', () => {
  const issueBody = journeyReport('2026-09-22', 539, [['hr-4366-119', 'Rule H. Res. 988 passed House.']]);
  const nov22 = journeyReport('2026-11-22', 638, [['sjres-124-119', SJRES_124]]);

  test('the same sentence on a later night, with a new date and corpus count, is not new', () => {
    const nov23 = journeyReport('2026-11-23', 640, [['sjres-124-119', SJRES_124]]);
    expect(unseenFindings(nov23, [issueBody, nov22])).toEqual([]);
  });

  test('a sentence the issue has never held is new — and only that one', () => {
    const NEW = 'Motion to table the motion to proceed agreed to in Senate by Voice Vote.';
    const report = journeyReport('2026-11-24', 640, [
      ['sjres-124-119', SJRES_124],
      ['s-77-119', NEW],
    ]);
    expect(unseenFindings(report, [issueBody, nov22])).toEqual([{ slug: 's-77-119', quote: NEW, line: null }]);
  });

  test('the same sentence on a DIFFERENT bill is new: slug and sentence must sit in one earlier text', () => {
    const report = journeyReport('2026-11-24', 640, [['sjres-200-119', SJRES_124]]);
    expect(unseenFindings(report, [issueBody, nov22])).toHaveLength(1);
  });

  test('a sentence that was in the issue body counts, not only one in a comment', () => {
    expect(findingSeen({ slug: 'hr-4366-119', quote: 'Rule H. Res. 988 passed House.', line: null }, [issueBody])).toBe(true);
  });

  test('whitespace and wrapping never make a repeat look new', () => {
    const wrapped = `- **sjres-124-119** — read:\n  > The motion to discharge fell when\n  > the point of order was well taken.`;
    expect(unseenFindings(journeyReport('2026-11-25', 1, [['sjres-124-119', SJRES_124]]), [wrapped])).toEqual([]);
  });

  test('an issue with no earlier text: everything is new', () => {
    expect(unseenFindings(nov22, [])).toHaveLength(1);
  });
});

test.describe('the clean-night note', () => {
  test('says the issue can be closed, carries its marker, and never closes anything itself', () => {
    const c = cleanComment('2026-11-24');
    expect(c).toContain(CLEAN_MARKER);
    expect(c).toContain('2026-11-24');
    expect(c).toContain('can be closed');
  });

  test('posts once per clean-up: not when the newest text is already the note', () => {
    expect(needsCleanComment(['body', 'a report'])).toBe(true);
    expect(needsCleanComment(['body', 'a report', cleanComment('2026-11-24')])).toBe(false);
    // A finding after the note, then clean again: say it again.
    expect(needsCleanComment(['body', cleanComment('2026-11-24'), 'a new report'])).toBe(true);
  });
});
