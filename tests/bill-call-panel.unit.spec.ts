import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { billCallPanelProps } from '../lib/bill-call-panel';
import { getBill } from '../lib/core/bills';
import { formatCitation } from '../lib/format';
import { lastFailedVote, settledDecision } from '../lib/journey';

/*
 * THE BILL PAGE'S CALL PANEL, CARRIED ONTO A ONE-BILL BIG QUESTION
 * (wireframes v2, 2026-09-29, Q6 "b"). lib/bill-call-panel.ts computes the
 * props /bills/[id] hands ActionPanel, so the question page can hand it the
 * same ones. What is pinned here:
 *   - no panel where the bill page shows none (a settled record) or there is
 *     no bill;
 *   - the owner's pick (a) line, "The last attempt failed…", word for word,
 *     from the record;
 *   - the call-log labels, by the bill page's rule;
 *   - DRIFT: the bill page passes ActionPanel exactly the props this helper
 *     returns, no more and no fewer. If the bill page's panel grows a prop,
 *     this fails until the helper (and so the question page) carries it too.
 * The rendered comparison of the two panels is in tests/question-pages.spec.ts.
 */

const ROOT = process.cwd();
const fmtLong = (locale: string) => (d: string) =>
  new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(d));
const deps = (locale: 'en' | 'es') => {
  const tr = createTranslator({ locale, messages: locale === 'en' ? en : es }) as unknown as (
    key: string,
    values?: Record<string, string | number>
  ) => string;
  return { t: (key: string, values?: Record<string, string | number>) => tr(key, values), fmtDate: fmtLong(locale) };
};

test.describe('no panel to draw', () => {
  test('an unknown slug', () => {
    expect(billCallPanelProps('hr-0-000', 'en', deps('en'))).toBeNull();
  });

  test('a record the bill page shows as settled (law, rejected, adopted)', () => {
    for (const slug of ['hconres-89-119', 'hconres-86-119', 'hr-6500-119']) {
      const b = getBill(slug);
      if (!b) continue;
      expect(settledDecision(b), slug).not.toBeNull();
      expect(billCallPanelProps(slug, 'en', deps('en')), slug).toBeNull();
    }
  });
});

test.describe('the props, from the record', () => {
  test('a failed procedural vote prints the owner’s pick (a) line, in both languages', () => {
    const slug = 'sjres-185-119';
    const b = getBill(slug);
    test.skip(!b || lastFailedVote(b) === null, 'S.J.Res. 185 no longer ends on a failed motion to proceed');
    expect(billCallPanelProps(slug, 'en', deps('en'))?.lastAttempt).toBe(
      'The last attempt failed: the Senate voted against taking it up, 47–50, on June 24, 2026.'
    );
    expect(billCallPanelProps(slug, 'es', deps('es'))?.lastAttempt).toBe(
      createTranslator({ locale: 'es', messages: es })('bill.lastAttempt', {
        procedure: 'proceed',
        chamber: 'Senate',
        tally: 'yes',
        yeas: 47,
        nays: 50,
        hasDate: 'yes',
        date: fmtLong('es')('2026-06-24'),
      })
    );
  });

  test('an open bill with no failed vote: citation, headline, no last-attempt line, labels in both locales', () => {
    const slug = 's-4668-119';
    const b = getBill(slug);
    test.skip(!b || settledDecision(b) !== null, 'S. 4668 is not an open decision in this corpus');
    const p = billCallPanelProps(slug, 'en', deps('en'))!;
    expect(p.slug).toBe(slug);
    expect(p.identifier).toBe(formatCitation(b!.bill_type, b!.bill_number));
    expect(p.title).toBe(b!.ai_headline ?? b!.short_title ?? b!.title);
    expect(p.lastAttempt).toBeNull();
    // A live target, when the record gives one, follows the record, and
    // routing never guesses a chamber. Read from the record rather than
    // pinned: S. 4668 was on the Senate floor when this was written, then
    // passed the Senate 77–22 on 2026-09-28, which sends the call to the
    // House. A passage sentence names the chamber that acted; the call goes
    // to the other one.
    const acted = /\bPassed (House|Senate)\b/i.exec(b!.last_action_text ?? '')?.[1]?.toLowerCase();
    if (p.liveTarget && acted) expect(p.liveTarget.chamber).toBe(acted === 'senate' ? 'house' : 'senate');
    // The call-log label names the bill once: the citation is prefixed only
    // when the headline does not already carry it.
    for (const label of [p.recordLabels.en, p.recordLabels.es]) {
      expect(label.replace(/[.\s]/g, '').toLowerCase()).toContain(p.identifier.replace(/[.\s]/g, '').toLowerCase());
    }
    // The Spanish page asks for the same record labels (both locales, always).
    expect(billCallPanelProps(slug, 'es', deps('es'))!.recordLabels).toEqual(p.recordLabels);
  });
});

test('DRIFT: the bill page hands ActionPanel exactly the props this helper returns', () => {
  const page = readFileSync(join(ROOT, 'app/[locale]/bills/[id]/page.tsx'), 'utf8');
  const block = /<ActionPanel\b([\s\S]*?)\/>/.exec(page);
  expect(block, 'the bill page renders <ActionPanel … />').not.toBeNull();
  const passed = [...block![1].matchAll(/^\s*([a-zA-Z]+)=/gm)].map((m) => m[1]).sort();
  const open = ['s-4668-119', 'sjres-185-119', 'hconres-93-119'].find((slug) => {
    const b = getBill(slug);
    return b && settledDecision(b) === null;
  });
  test.skip(!open, 'no open sample bill in the corpus');
  const returned = Object.keys(billCallPanelProps(open!, 'en', deps('en'))!).sort();
  expect(returned).toEqual(passed);
});
