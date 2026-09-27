import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import {
  amendedInCommitteeSince,
  amendedSince,
  billSponsor,
  changedSince,
  decodeSource,
  type DecodeSource,
} from '../lib/bill-provenance';
import { getAllBills, getAllLegislators, getLegislator } from '../lib/core';
import { meetsAfterDay } from '../lib/today';
import { votingMember } from '../lib/votes';
import type { RollCall } from '../lib/types';

/*
 * THE 2026-09-27 COPY-TRUTH SWEEP (SY-43, SY-44, SY-33, SY-25, SY-31): five
 * shipped claims that were false the day the audit read them. Pure Node — no
 * page, no server. Synthetic records for the helpers, so nothing here pins a
 * corpus slug; the rendered surfaces are pinned by key and data-* hook in
 * tests/copy-truth.spec.ts.
 */

const LOCALES = [
  ['en', en],
  ['es', es],
] as const;

// ---- SY-43: the feedback notice --------------------------------------------

test.describe('SY-43 feedback notice says where a note goes', () => {
  for (const [locale, m] of LOCALES) {
    for (const key of ['notice', 'noticePartnership'] as const) {
      test(`${locale} feedback.${key}: public GitHub issue, never "private", no contact ask`, () => {
        const s = m.feedback[key];
        // app/api/feedback files an issue in a PUBLIC repository.
        expect(s).toContain('GitHub');
        expect(s).not.toMatch(/private|privad[oa]/i);
        // The retired ask: "include a way to reach you (email or phone)".
        expect(s).not.toMatch(/email or phone|correo o tel[eé]fono|way to reach you|forma de contactarte/i);
        // Both notices keep the "no personal details" instruction.
        expect(s).toMatch(locale === 'en' ? /Don't include personal details/ : /No incluyas datos personales/);
      });
    }
  }
});

// ---- SY-44: "two senators" for everyone ------------------------------------

test.describe('SY-44 the find-your-members strings are true in DC and the territories', () => {
  const KEYS = [
    ['home', 'how1Title'],
    ['home', 'how1Body'],
    ['reps', 'noZip'],
    ['reps', 'previewNote'],
  ] as const;
  for (const [locale, m] of LOCALES) {
    for (const [ns, key] of KEYS) {
      test(`${locale} ${ns}.${key}`, () => {
        const s = (m[ns] as Record<string, string>)[key];
        expect(s).not.toMatch(/\byour three\b|\btus tres\b/i);
        // Naming two senators is fine only beside the delegate it does not apply to.
        if (/two senators|dos senadores/i.test(s)) expect(s).toMatch(/delegate|delegad[oa]/i);
      });
    }
  }
});

// ---- SY-33: the sponsor ----------------------------------------------------

test.describe('SY-33 billSponsor', () => {
  const sitting = { bioguide: 'X000001', name: 'Pat Example', type: 'sen' as const, state: 'TX' };
  const lookups = {
    legislator: (id: string) => (id === sitting.bioguide ? sitting : undefined),
    formerMember: (id: string) =>
      id === 'X000002' ? { id, name: 'Sam Former', state: 'SC', chamber: 'senate' as const } : undefined,
  };

  test('a sitting member: name, seat, state, and a page to link to', () => {
    expect(billSponsor({ sponsor_bioguide_id: 'X000001', bill_type: 's' }, lookups)).toEqual({
      bioguide: 'X000001',
      name: 'Pat Example',
      type: 'sen',
      state: 'TX',
      hasPage: true,
    });
  });

  test('a member who left the roster but is named in a roll call: printed, never linked', () => {
    expect(billSponsor({ sponsor_bioguide_id: 'X000002', bill_type: 'sres' }, lookups)).toEqual({
      bioguide: 'X000002',
      name: 'Sam Former',
      type: 'sen',
      state: 'SC',
      hasPage: false,
    });
  });

  test('the seat is the one the bill was sponsored from, not the roster seat today', () => {
    // A member who moved from the House to the Senate: their old House bill
    // still names a Representative, and the state carries over.
    expect(billSponsor({ sponsor_bioguide_id: 'X000001', bill_type: 'hr' }, lookups)?.type).toBe('rep');
    expect(billSponsor({ sponsor_bioguide_id: 'X000001', bill_type: 'hjres' }, lookups)?.type).toBe('rep');
    expect(billSponsor({ sponsor_bioguide_id: 'X000002', bill_type: 'hconres' }, lookups)?.type).toBe('rep');
    // A bill type this does not recognise falls back to the roster's seat.
    expect(billSponsor({ sponsor_bioguide_id: 'X000001', bill_type: 'zz' }, lookups)?.type).toBe('sen');
  });

  test('an id no stored file names, or no id at all: nothing', () => {
    expect(billSponsor({ sponsor_bioguide_id: 'X000009', bill_type: 's' }, lookups)).toBeNull();
    expect(billSponsor({ sponsor_bioguide_id: null, bill_type: 's' }, lookups)).toBeNull();
  });

  test('corpus: every linked sponsor has a generated member page (the link never 404s)', () => {
    const pages = new Set(getAllLegislators().map((l) => l.bioguide));
    for (const b of getAllBills()) {
      const s = billSponsor(b, { legislator: getLegislator, formerMember: votingMember });
      if (s?.hasPage) expect(pages.has(s.bioguide), b.full_identifier).toBe(true);
    }
  });
});

// ---- SY-25: which text the decode read ---------------------------------------

test.describe('SY-25 decodeSource / amendedSince', () => {
  const decoded = { ai_summary: 'x', ai_sections: null };

  test('a stamped decode names its version and the version day', () => {
    expect(
      decodeSource({ ...decoded, text_version_type: 'Reported to Senate', text_version_date: '2026-06-24T04:00:00Z' }),
    ).toEqual({ version: 'Reported to Senate', date: '2026-06-24' });
  });

  test('a version Congress.gov dates with nothing keeps its name and claims no date', () => {
    expect(decodeSource({ ...decoded, text_version_type: 'Enrolled Bill', text_version_date: null })).toEqual({
      version: 'Enrolled Bill',
      date: null,
    });
  });

  test('no stamp, or no decode: nothing — unknown is never printed', () => {
    expect(decodeSource({ ...decoded, text_version_type: null, text_version_date: '2026-06-24T04:00:00Z' })).toBeNull();
    expect(decodeSource({ ...decoded })).toBeNull();
    expect(
      decodeSource({
        ai_summary: null,
        ai_sections: null,
        text_version_type: 'Introduced in House',
        text_version_date: '2026-01-01T05:00:00Z',
      }),
    ).toBeNull();
  });

  const src: DecodeSource = { version: 'Reported to Senate', date: '2026-06-24' };
  const rc = (over: Partial<RollCall>) => ({
    chamber: 'senate' as const,
    question: 'On the Amendment S.Amdt. 1 to S. 1 (No short title on file)',
    result: 'Amendment Agreed to',
    date: '2026-09-24',
    roll: 242,
    source: 'https://www.senate.gov/x.xml',
    ...over,
  });

  test('an amendment to the bill agreed to after the text day is reported', () => {
    expect(amendedSince(src, [rc({})])).toEqual({
      chamber: 'senate',
      date: '2026-09-24',
      roll: 242,
      source: 'https://www.senate.gov/x.xml',
    });
  });

  test('the newest qualifying vote wins', () => {
    const hit = amendedSince(src, [rc({ date: '2026-07-01', roll: 10 }), rc({ date: '2026-09-24', roll: 242 })]);
    expect(hit?.date).toBe('2026-09-24');
  });

  test('nothing claimed on or before the text day, or without a dated source', () => {
    expect(amendedSince(src, [rc({ date: '2026-06-24' })])).toBeNull();
    expect(amendedSince(src, [rc({ date: '2026-06-01' })])).toBeNull();
    expect(amendedSince({ version: 'Enrolled Bill', date: null }, [rc({})])).toBeNull();
    expect(amendedSince(null, [rc({})])).toBeNull();
  });

  test('only a first-degree amendment agreed to — never a rejected one, a second-degree one, or a House passage', () => {
    expect(amendedSince(src, [rc({ result: 'Amendment Rejected' })])).toBeNull();
    expect(
      amendedSince(src, [rc({ question: 'On the Amendment S.Amdt. 2 to S.Amdt. 1 to S. 1 (No short title on file)' })]),
    ).toBeNull();
    expect(amendedSince(src, [rc({ question: 'On the Motion to Table S.Amdt. 1 to S. 1', result: 'Motion to Table Agreed to' })])).toBeNull();
    expect(
      amendedSince(src, [
        rc({ chamber: 'house', question: 'On Motion to Suspend the Rules and Pass, as Amended', result: 'Passed' }),
      ]),
    ).toBeNull();
  });
});

test.describe('SY-25 amendedInCommitteeSince / changedSince', () => {
  const src: DecodeSource = { version: 'Introduced in House', date: '2026-09-02' };
  const act = (last_action_text: string | null, last_action_date: string | null = '2026-09-16') => ({
    last_action_text,
    last_action_date,
  });

  test('every committee shape the corpus holds, after the text day, is reported with its date', () => {
    for (const text of [
      'Ordered to be Reported (Amended) by the Yeas and Nays: 42 - 7.',
      'Ordered to be Reported (Amended) by Voice Vote.',
      'Ordered to be Reported in the Nature of a Substitute by the Yeas and Nays: 23 - 0.',
      'Ordered to be Reported in the Nature of a Substitute (Amended) by Unanimous Consent.',
      'Ordered to be Reported Unfavorably (Amended) by the Yeas and Nays: 20 - 15.',
      'Reported (Amended) by the Committee on Natural Resources. H. Rept. 119-400, Part I.',
      'Committee on Veterans\' Affairs. Ordered to be reported with an amendment in the nature of a substitute favorably.',
      'Committee on Commerce, Science, and Transportation. Ordered to be reported with amendments favorably.',
    ]) {
      expect(amendedInCommitteeSince(src, act(text)), text).toEqual({ date: '2026-09-16' });
    }
  });

  test('no changes, not yet the full committee, or set aside: nothing', () => {
    for (const text of [
      'Ordered to be Reported by the Yeas and Nays: 30 - 0.',
      'Ordered to be Reported by Voice Vote.',
      'Committee on Finance. Ordered to be reported without amendment favorably.',
      'Reported by the Committee on Natural Resources. H. Rept. 119-401, Part I.',
      'Forwarded by Subcommittee to Full Committee (Amended) by Voice Vote.',
      'The committee substitute tabled by Voice Vote.',
      'Passed Senate without amendment by Unanimous Consent.',
      'Referred to the House Committee on the Judiciary.',
    ]) {
      expect(amendedInCommitteeSince(src, act(text)), text).toBeNull();
    }
  });

  test('on or before the text day, undated, or no action on file: nothing', () => {
    const markup = 'Ordered to be Reported (Amended) by Voice Vote.';
    expect(amendedInCommitteeSince(src, act(markup, '2026-09-02'))).toBeNull();
    expect(amendedInCommitteeSince(src, act(markup, '2026-08-30'))).toBeNull();
    expect(amendedInCommitteeSince(src, act(markup, null))).toBeNull();
    expect(amendedInCommitteeSince(src, act(null))).toBeNull();
    expect(amendedInCommitteeSince({ version: 'Enrolled Bill', date: null }, act(markup))).toBeNull();
    expect(amendedInCommitteeSince(null, act(markup))).toBeNull();
  });

  const floor = { chamber: 'senate' as const, date: '2026-09-24', roll: 242, source: 'https://www.senate.gov/x.xml' };

  test('one line: the newer fact wins, and the floor vote wins a tie', () => {
    expect(changedSince(null, null)).toBeNull();
    expect(changedSince(floor, null)).toEqual({ kind: 'floor', ...floor });
    expect(changedSince(null, { date: '2026-09-16' })).toEqual({ kind: 'committee', date: '2026-09-16' });
    expect(changedSince(floor, { date: '2026-09-16' })?.kind).toBe('floor');
    expect(changedSince(floor, { date: '2026-09-30' })).toEqual({ kind: 'committee', date: '2026-09-30' });
    expect(changedSince(floor, { date: '2026-09-24' })?.kind).toBe('floor');
  });
});

// ---- SY-31: "in session" is a claim about a day ------------------------------

test.describe('SY-31 meetsAfterDay', () => {
  const next = (iso: string | null, label: string | null = '3 p.m., Monday, September 28') => ({ iso, label });

  test('in session, next sitting after the brief day: say when it next meets', () => {
    expect(meetsAfterDay({ session: 'in_session', nextMeeting: next('2026-09-28') }, '2026-09-26')).toBe(true);
  });

  test('a sitting ON the brief day keeps "in session"', () => {
    expect(meetsAfterDay({ session: 'in_session', nextMeeting: next('2026-09-28') }, '2026-09-28')).toBe(false);
  });

  test('no derivable date, no meeting, or not in session: no claim', () => {
    expect(meetsAfterDay({ session: 'in_session', nextMeeting: next(null) }, '2026-09-26')).toBe(false);
    expect(meetsAfterDay({ session: 'in_session', nextMeeting: null }, '2026-09-26')).toBe(false);
    expect(meetsAfterDay({ session: 'out_of_session', nextMeeting: next('2026-09-28') }, '2026-09-26')).toBe(false);
    expect(meetsAfterDay({ session: 'unknown', nextMeeting: next('2026-09-28') }, '2026-09-26')).toBe(false);
  });
});

// ---- the new keys exist in both languages, with the same arguments ----------

test('every key this sweep added is in both locales', () => {
  const pairs: [Record<string, unknown>, Record<string, unknown>, string][] = [
    [en.bill, es.bill, 'sponsorLine'],
    [en.bill, es.bill, 'decodedFromVersion'],
    [en.bill, es.bill, 'decodedFromVersionUndated'],
    [en.bill, es.bill, 'decodedAmendedSince'],
    [en.bill, es.bill, 'decodedCommitteeChangedSince'],
    [en.today, es.today, 'chamberInNext'],
  ];
  const args = (s: string) => [...s.matchAll(/\{(\w+)[,}]/g)].map((x) => x[1]).sort();
  const tags = (s: string) => [...s.matchAll(/<(\w+)>/g)].map((x) => x[1]).sort();
  for (const [a, b, key] of pairs) {
    expect(typeof a[key], key).toBe('string');
    expect(typeof b[key], key).toBe('string');
    expect(args(b[key] as string), key).toEqual(args(a[key] as string));
    expect(tags(b[key] as string), key).toEqual(tags(a[key] as string));
  }
});
