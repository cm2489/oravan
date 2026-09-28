import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
// Added press names (scripts/press-names.mjs) and the query they widen
// (scripts/coverage-query.mjs queryWithAddedNames). Pure, no filesystem except
// the last block, which validates the committed data file when there is one.
import { isUsablePressName, queryFor, queryWithAddedNames } from '../scripts/coverage-query.mjs';
import {
  MAX_ADDED_NAMES,
  PRESS_NAMES_PATH,
  formatPressNames,
  loadPressNames,
  parsePressNames,
  printsName,
  unknownPressNameSlugs,
} from '../scripts/press-names.mjs';

type Json = Record<string, unknown>;
const bill = (over: Json) => ({
  bill_type: 'hr',
  bill_number: 3633,
  congress_number: 119,
  title: 'Digital Asset Market Clarity Act',
  press_names: null,
  news_query: null,
  ...over,
});
const ev = (title: string, over: Json = {}) => ({ title, url: 'https://example.com/a', ...over });
const doc = (bills: Json) => ({ _note: 'test', bills });
const CLARITY = { add: ['CLARITY Act'], evidence: [ev('CLARITY Act Fails 49-50: SEC, CFTC Write Rules Anyway')] };

test.describe('printsName (does a stored headline print the name?)', () => {
  test('case-insensitive, punctuation and quote marks read as a space', () => {
    expect(printsName('Blockchain Association CEO Exits as CLARITY Act Stalls', 'Clarity Act')).toBe(true);
    expect(printsName('Fetterman Joins GOP to Block Iran War Powers Resolution — Again', 'Iran War Powers Resolution')).toBe(true);
    expect(printsName('Congress Passed the ‘Common Cents’ Act', 'Common Cents Act')).toBe(true);
    expect(printsName("Congress Passed the 'Common Cents' Act", 'Common Cents Act')).toBe(true);
    expect(printsName('Congress Passed the "Common Cents" Act', 'Common Cents Act')).toBe(true);
  });
  test('whole words only', () => {
    expect(printsName('Clarity Actions stall', 'Clarity Act')).toBe(false);
    expect(printsName('The CLARITY Acts', 'CLARITY Act')).toBe(false);
  });
  test('either apostrophe form', () => {
    expect(printsName('Kayleigh’s Law passes', "Kayleigh's Law")).toBe(true);
    expect(printsName("Kayleigh's Law passes", 'Kayleigh’s Law')).toBe(true);
  });
  test('an empty name is printed nowhere', () => {
    expect(printsName('Anything', '  ')).toBe(false);
  });
});

test.describe('parsePressNames', () => {
  test('no file: nothing added, nothing wrong', () => {
    for (const raw of [null, undefined]) {
      const r = parsePressNames(raw);
      expect(r.problems).toEqual([]);
      expect(r.bySlug.size).toBe(0);
    }
  });

  test('a valid file: names by slug, trimmed', () => {
    const r = parsePressNames(
      doc({
        'hr-3633-119': { add: ['  CLARITY Act '], note: 'why', evidence: [ev('CLARITY Act Fails 49-50', { source: 'financefeeds.com', published: '2026-09-24', stored_under: 'hr-3633-119' })] },
        'hconres-89-119': { add: ['Iran War Powers Resolution'], evidence: [ev('Senate again fails to adopt Iran War Powers Resolution despite growing criticism')] },
      }),
    );
    expect(r.problems).toEqual([]);
    expect([...r.bySlug]).toEqual([
      ['hr-3633-119', ['CLARITY Act']],
      ['hconres-89-119', ['Iran War Powers Resolution']],
    ]);
  });

  test('an empty "bills" map is valid and adds nothing', () => {
    const r = parsePressNames(doc({}));
    expect(r.problems).toEqual([]);
    expect(r.bySlug.size).toBe(0);
  });

  const rejects: Array<[string, unknown, RegExp]> = [
    ['a root that is not an object', ['x'], /root must be an object/],
    ['no "bills" map', { outlets: {} }, /"bills" must be an object/],
    ['"bills" as a list', { bills: [] }, /"bills" must be an object/],
    ['a key that is not a coverage slug', doc({ 'HR-3633-119': CLARITY }), /"HR-3633-119" is not a coverage slug/],
    ['a key with a zero number', doc({ 'hr-0-119': CLARITY }), /not a coverage slug/],
    ['an entry that is not an object', doc({ 'hr-3633-119': ['CLARITY Act'] }), /must be an object with "add" and "evidence"/],
    ['an unknown entry key (a typo)', doc({ 'hr-3633-119': { ...CLARITY, adds: ['x'] } }), /unknown key "adds"/],
    ['no names', doc({ 'hr-3633-119': { ...CLARITY, add: [] } }), /"add" must be a non-empty list/],
    ['too many names', doc({ 'hr-3633-119': { add: ['A Act', 'B Act', 'C Act', 'D Act'], evidence: [ev('A Act B Act C Act D Act')] } }), new RegExp(`at most ${MAX_ADDED_NAMES} added names`)],
    ['a bare citation as a name', doc({ 'hr-3633-119': { add: ['H.R. 3633'], evidence: [ev('H.R. 3633 fails')] } }), /not a usable name/],
    ['a name over 60 characters', doc({ 'hr-3633-119': { add: ['x'.repeat(61)], evidence: [ev('x'.repeat(61))] } }), /not a usable name/],
    ['a name that is not a string', doc({ 'hr-3633-119': { add: [7], evidence: [ev('7')] } }), /not a usable name/],
    ['the same name twice, any case', doc({ 'hr-3633-119': { add: ['CLARITY Act', 'Clarity Act'], evidence: CLARITY.evidence } }), /listed twice/],
    ['no evidence', doc({ 'hr-3633-119': { add: ['CLARITY Act'] } }), /"evidence" must list the stored headlines/],
    ['empty evidence', doc({ 'hr-3633-119': { add: ['CLARITY Act'], evidence: [] } }), /"evidence" must list/],
    ['evidence without a title', doc({ 'hr-3633-119': { add: ['CLARITY Act'], evidence: [{ url: 'https://x.com/a' }] } }), /evidence\[0\] has no "title"/],
    ['evidence without a URL', doc({ 'hr-3633-119': { add: ['CLARITY Act'], evidence: [{ title: 'CLARITY Act Fails' }] } }), /evidence\[0\] has no http\(s\) "url"/],
    ['evidence with a bad date', doc({ 'hr-3633-119': { add: ['CLARITY Act'], evidence: [ev('CLARITY Act Fails', { published: 'Sep 24' })] } }), /"published" must be YYYY-MM-DD/],
    ['evidence stored under a non-slug', doc({ 'hr-3633-119': { add: ['CLARITY Act'], evidence: [ev('CLARITY Act Fails', { stored_under: 'H.R. 3633' })] } }), /"stored_under" must be a coverage slug/],
    ['an unknown evidence key', doc({ 'hr-3633-119': { add: ['CLARITY Act'], evidence: [ev('CLARITY Act Fails', { snippet: 'x' })] } }), /unknown key "snippet"/],
    ['a name no cited headline prints', doc({ 'hconres-89-119': { add: ['Iran War Powers Resolution'], evidence: [ev('Senate rejects resolution to halt Trump’s war with Iran')] } }), /no cited headline prints "Iran War Powers Resolution"/],
  ];
  for (const [what, raw, why] of rejects) {
    test(`fails CLOSED on ${what}: the whole file adds nothing`, () => {
      const r = parsePressNames(raw);
      expect(r.problems.join('\n')).toMatch(why);
      expect(r.bySlug.size).toBe(0);
    });
  }

  test('one bad entry rejects the good ones beside it', () => {
    const r = parsePressNames(doc({ 'hr-3633-119': CLARITY, 'hconres-89-119': { add: ['Iran War Powers Resolution'], evidence: [ev('unrelated')] } }));
    expect(r.problems).toHaveLength(1);
    expect(r.bySlug.size).toBe(0);
  });
});

test.describe('loadPressNames', () => {
  test('reads data/press-names.json, and only that path', () => {
    expect(PRESS_NAMES_PATH).toBe('data/press-names.json');
    const seen: string[] = [];
    const r = loadPressNames({
      exists: (p: string) => (seen.push(p), true),
      readJSON: (p: string) => (seen.push(p), doc({ 'hr-3633-119': CLARITY })),
    });
    expect(seen).toEqual([PRESS_NAMES_PATH, PRESS_NAMES_PATH]);
    expect(r.bySlug.get('hr-3633-119')).toEqual(['CLARITY Act']);
  });
  test('no file: nothing added, and the file is never read', () => {
    const r = loadPressNames({
      exists: () => false,
      readJSON: () => {
        throw new Error('must not read');
      },
    });
    expect(r).toEqual({ bySlug: new Map(), problems: [] });
  });
  test('a file that is not JSON fails closed and says so', () => {
    const r = loadPressNames({
      exists: () => true,
      readJSON: () => {
        throw new SyntaxError('Unexpected token } in JSON');
      },
    });
    expect(r.bySlug.size).toBe(0);
    expect(r.problems).toEqual(['data/press-names.json is not valid JSON (Unexpected token } in JSON)']);
  });
});

test.describe('queryWithAddedNames (only ever widens the nightly query)', () => {
  test('no added names: exactly queryFor', () => {
    const cases = [
      bill({ press_names: ['Digital Asset Market Clarity Act', 'DAMC Act'] }),
      bill({ bill_type: 'hconres', bill_number: 89, title: 'Directing the President…', news_query: 'President "Iran hostilities"' }),
      bill({ bill_type: 's', bill_number: 3172, title: 'A bill to repeal certain Acts that impose sanctions upon Syria.', news_query: 'Syria sanctions repeal' }),
      bill({ title: 'SCAM Act' }),
    ];
    for (const b of cases) {
      for (const added of [undefined, null, []]) expect(queryWithAddedNames(b, added)).toBe(queryFor(b));
    }
  });

  test('a named bill: the added name is OR-ed on after everything queryFor built', () => {
    const b = bill({ press_names: ['Digital Asset Market Clarity Act', 'DAMC Act'] });
    expect(queryWithAddedNames(b, ['CLARITY Act'])).toBe('"Digital Asset Market Clarity Act" | "DAMC Act" | "H.R. 3633" | "CLARITY Act"');
  });

  test('a subject-query bill KEEPS its subject arm (queryFor alone would drop it for a named bill)', () => {
    const b = bill({ bill_type: 'hconres', bill_number: 89, title: 'Directing the President…', news_query: 'President "Iran hostilities"' });
    expect(queryWithAddedNames(b, ['Iran War Powers Resolution'])).toBe(
      '(President "Iran hostilities") | "H. Con. Res. 89" | "Iran War Powers Resolution"',
    );
    // What merging the name into press_names would have done instead — the
    // subject arm gone. This is why the added names are not merged there.
    expect(queryFor({ ...b, press_names: ['Iran War Powers Resolution'] })).toBe('"Iran War Powers Resolution" | "H. Con. Res. 89"');
  });

  test('a Senate bill keeps its guarded citation', () => {
    const b = bill({ bill_type: 's', bill_number: 3172, title: 'A bill to repeal certain Acts that impose sanctions upon Syria.', news_query: 'Syria sanctions repeal' });
    expect(queryWithAddedNames(b, ['Syria Test Act'])).toBe('(Syria sanctions repeal) | ("S. 3172" + (senate | congress)) | "Syria Test Act"');
  });

  test('a name the bill already carries, in any case, is not repeated', () => {
    const b = bill({ press_names: ['CLARITY Act'] });
    expect(queryWithAddedNames(b, ['clarity act'])).toBe(queryFor(b));
  });

  test('a name past queryFor’s four-name cap is not "already carried", so it is added', () => {
    const b = bill({ press_names: ["A's Act", "B's Act", 'C Act'] }); // 4 apostrophe variants fill the cap; C is cut
    expect(queryFor(b)).not.toContain('"C Act"');
    expect(queryWithAddedNames(b, ['C Act'])).toBe(`${queryFor(b)} | "C Act"`);
  });

  test('apostrophe names get both forms, as queryFor gives them', () => {
    // A formal long title, so queryFor has no title arm: just the citation.
    expect(queryWithAddedNames(bill({ title: 'To amend title 18 to protect children.' }), ["Kayleigh's Law"])).toBe(
      '"H.R. 3633" | "Kayleigh’s Law" | "Kayleigh\'s Law"',
    );
  });

  test('an unusable added name is skipped, never sent', () => {
    const b = bill({ press_names: ['CLARITY Act'] });
    expect(queryWithAddedNames(b, ['H.R. 3633', '  ', 'x'.repeat(61)])).toBe(queryFor(b));
    expect(isUsablePressName('HR 7086')).toBe(false);
    expect(isUsablePressName('CLARITY Act')).toBe(true);
  });

  test('over the WHOLE real corpus: every bill’s query is its old query plus the added clause, nothing removed', () => {
    const bills = JSON.parse(readFileSync('data/bills.json', 'utf8')) as Json[];
    expect(bills.length).toBeGreaterThan(1000);
    for (const b of bills) {
      const base = queryFor(b);
      expect(queryWithAddedNames(b, ['Zzq Added Name Act'])).toBe(`${base} | "Zzq Added Name Act"`);
    }
  });
});

test.describe('run-log helpers', () => {
  test('unknownPressNameSlugs names the slugs the corpus lacks, sorted', () => {
    const bySlug = new Map([
      ['hr-9-119', ['A Act']],
      ['hr-3633-119', ['CLARITY Act']],
      ['hr-1-119', ['B Act']],
    ]);
    expect(unknownPressNameSlugs(bySlug, ['hr-3633-119'])).toEqual(['hr-1-119', 'hr-9-119']);
    expect(unknownPressNameSlugs(new Map(), [])).toEqual([]);
  });
  test('formatPressNames: one stable line', () => {
    expect(formatPressNames(new Map())).toBe('no added names (data/press-names.json absent or empty)');
    expect(formatPressNames(new Map([['hr-3633-119', ['CLARITY Act']], ['hconres-89-119', ['Iran War Powers Resolution']]]))).toBe(
      '2 added name(s) on 2 bill(s) — hr-3633-119: "CLARITY Act"; hconres-89-119: "Iran War Powers Resolution"',
    );
  });
});

/* THE COMMITTED FILE. When data/press-names.json exists it must parse with no
   problem (a bad file is red on the PR that adds it, not silent on the night),
   name only bills the corpus holds, and every name must actually reach its
   bill's query. With no file there is nothing to check. */
test.describe('data/press-names.json (the committed file, when there is one)', () => {
  const present = existsSync(PRESS_NAMES_PATH);
  test('parses, names real bills, and every added name reaches its bill’s query', () => {
    test.skip(!present, 'no data/press-names.json on this branch');
    const r = parsePressNames(JSON.parse(readFileSync(PRESS_NAMES_PATH, 'utf8')));
    expect(r.problems).toEqual([]);
    expect(r.bySlug.size).toBeGreaterThan(0);
    const bills = JSON.parse(readFileSync('data/bills.json', 'utf8')) as Array<Json & { bill_type: string; bill_number: number; congress_number: number }>;
    const bySlug = new Map(bills.map((b) => [`${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase(), b]));
    expect(unknownPressNameSlugs(r.bySlug, bySlug.keys())).toEqual([]);
    for (const [slug, names] of r.bySlug) {
      const q = queryWithAddedNames(bySlug.get(slug), names);
      expect(q.startsWith(queryFor(bySlug.get(slug))), slug).toBe(true);
      for (const n of names) expect(q.toLowerCase(), `${slug}: ${n}`).toContain(`"${n.toLowerCase()}"`);
    }
  });
});
