import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// Pure, I/O-free module - see scripts/newsdesk-match.mjs's "the floor record"
// comment for the 2026-09-24 failure these pin. No network, no model: t3's
// prompt is built by a pure function precisely so this file can read it.
import {
  buildBillIndex,
  buildFloorRecord,
  buildT3Prompt,
  FLOOR_RECORD_HOURS,
  FLOOR_RESCUE_MAX,
  floorNote,
  formatT3Candidate,
  headlineCannotSeparate,
  headlineForMatching,
  looksLegislative,
  matchLocal,
  PHRASE_UNITS,
  rollFloorRecord,
  scoreCandidates,
  SHORT_TOKENS_KEPT,
  T3_CANDIDATES_MAX,
  titleFamily,
  tokenize,
} from '../scripts/newsdesk-match.mjs';

type Cand = { slug: string; weight: number; floor?: { kind: string; chamber: string | null; date: string | null }; rescued?: boolean };
const slugsOf = (r: ReturnType<typeof matchLocal>) => {
  if (!r || r.tier !== 'ambiguous') throw new Error(`expected an ambiguous verdict, got ${JSON.stringify(r)}`);
  return (r.candidates as Cand[]).map((c) => c.slug);
};
const candsOf = (r: ReturnType<typeof matchLocal>) => {
  if (!r || r.tier !== 'ambiguous') throw new Error(`expected an ambiguous verdict, got ${JSON.stringify(r)}`);
  return r.candidates as Cand[];
};

/*
 * The twelve Iran war-powers resolutions, with their REAL titles, news_query
 * values, statuses and last-action dates as data/bills.json held them on
 * 2026-09-25 - listed in corpus order, which is the order t2 used to break
 * their ties in. Two wordings of one sentence: six S.J.Res. and six
 * H.Con.Res. H.Con.Res. 89 is the one the Senate voted on, 49-50, on
 * 2026-09-24.
 */
const SJRES = 'A joint resolution to direct the removal of United States Armed Forces from hostilities within or against the Islamic Republic of Iran that have not been authorized by Congress.';
const HCONRES = 'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove United States Armed Forces from hostilities with Iran.';
const IRAN = [
  { bill_type: 'sjres', bill_number: 185, title: SJRES, news_query: 'Iran "war powers"', status: 'floor_vote', last_action_date: '2026-06-24' },
  { bill_type: 'sjres', bill_number: 172, title: SJRES, news_query: 'Congress "Iran hostilities"', status: 'floor_vote', last_action_date: '2026-06-16' },
  { bill_type: 'hconres', bill_number: 38, title: 'Directing the President pursuant to section 5(c) of the War Powers Resolution to remove United States Armed Forces from unauthorized hostilities in the Islamic Republic of Iran.', news_query: 'President "Iran hostilities"', status: 'floor_vote', last_action_date: '2026-03-05' },
  { bill_type: 'sjres', bill_number: 180, title: SJRES, news_query: 'Congress "Iran withdrawal"', status: 'floor_vote', last_action_date: '2026-07-23' },
  { bill_type: 'sjres', bill_number: 181, title: SJRES, news_query: 'Congress "Iran hostilities"', status: 'floor_vote', last_action_date: '2026-07-30' },
  { bill_type: 'hconres', bill_number: 93, title: HCONRES, news_query: 'President "Iran hostilities"', status: 'passed_chamber', last_action_date: '2026-09-16' },
  { bill_type: 'hconres', bill_number: 75, title: 'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove the United States Armed Forces from hostilities against the Islamic Republic of Iran.', news_query: 'War Powers Resolution', status: 'floor_vote', last_action_date: '2026-05-14' },
  { bill_type: 'hconres', bill_number: 86, title: HCONRES, news_query: 'President "Iran hostilities"', status: 'passed_chamber', last_action_date: '2026-06-24' },
  { bill_type: 'sjres', bill_number: 200, title: SJRES, news_query: 'Congress "military action Iran"', status: 'committee', last_action_date: '2026-07-13' },
  { bill_type: 'sjres', bill_number: 211, title: SJRES, news_query: 'Congress "Iran hostilities"', status: 'committee', last_action_date: '2026-08-06' },
  { bill_type: 'hconres', bill_number: 40, title: HCONRES, news_query: 'President "Iran hostilities"', status: 'floor_vote', last_action_date: '2026-04-16' },
  // Listed LAST, as the corpus happens to hold it - the position that used to
  // cost it the shortlist on every tie.
  { bill_type: 'hconres', bill_number: 89, title: HCONRES, news_query: 'President "Iran hostilities"', status: 'passed_chamber', last_action_date: '2026-07-23' },
];
/*
 * The same template for OTHER subjects, with their real titles, news_query
 * values, statuses and dates (data/bills.json, 2026-09-25). Every one of them
 * is a title family of every Iran resolution ("armed", "forces",
 * "hostilities"), which is exactly why a family alone must never let one
 * stand in for another. They precede the Iran resolutions, as in the corpus.
 */
const SIBLINGS = [
  { bill_type: 'sjres', bill_number: 98, title: 'A joint resolution to direct the removal of United States Armed Forces from hostilities within or against Venezuela that have not been authorized by Congress.', news_query: 'President "Venezuela hostilities"', status: 'passed_chamber', last_action_date: '2026-01-14' },
  { bill_type: 'sjres', bill_number: 124, title: 'A joint resolution to direct the removal of United States Armed Forces from hostilities within or against the Republic of Cuba that have not been authorized by Congress.', news_query: 'Congress "Cuba military"', status: 'floor_vote', last_action_date: '2026-04-28' },
  { bill_type: 'hjres', bill_number: 153, title: 'To direct the removal of United States Armed Forces from hostilities within or against the Republic of Cuba that have not been authorized by Congress.', news_query: 'Congress "Cuba military"', status: 'committee', last_action_date: '2026-03-24' },
  { bill_type: 'hconres', bill_number: 61, title: 'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove United States Armed Forces from hostilities with presidentially designated terrorist organizations in the Western Hemisphere.', news_query: 'President "armed forces" Western', status: 'floor_vote', last_action_date: '2025-12-17' },
];
// Unrelated bills, so distinctive-token counts behave like a corpus rather
// than like a list of near-duplicates: "resolution", "joint", "direct" and
// "president" are common words (df 80, 70, 37, 33 in the real corpus), and
// "venezuela" and "cuba" appear in a few other bills (df 3 and 4).
const OTHERS = [
  { bill_type: 's', bill_number: 3990, title: 'Collegiate Sports Media Rights Act', news_query: 'college sports broadcast', status: 'committee', last_action_date: '2026-06-01' },
  { bill_type: 's', bill_number: 4668, title: 'Protect College Sports Act', news_query: 'college sports athletes', status: 'floor_vote', last_action_date: '2026-09-24' },
  { bill_type: 's', bill_number: 4430, title: 'White House Safety and Security Act of 2026', news_query: 'White House "East Wing"', status: 'committee', last_action_date: '2026-09-10' },
  { bill_type: 'hr', bill_number: 8803, title: 'Iran War Oil Crisis Windfall Profits Tax Act', news_query: 'oil windfall tax', status: 'committee', last_action_date: '2026-08-01' },
  { bill_type: 's', bill_number: 3281, title: 'Sanctions on Iranian oil exports enforcement act', news_query: 'Iran oil sanctions', status: 'committee', last_action_date: '2026-05-01' },
  { bill_type: 'hr', bill_number: 7001, title: 'Venezuela Advancing Democracy Act', news_query: null, status: 'committee', last_action_date: '2026-02-01' },
  { bill_type: 'hr', bill_number: 7002, title: 'Venezuela Temporary Protected Status Act', news_query: null, status: 'committee', last_action_date: '2026-02-01' },
  { bill_type: 'hr', bill_number: 7003, title: 'Cuba Democracy and Human Rights Act', news_query: null, status: 'committee', last_action_date: '2026-02-01' },
  { bill_type: 'hr', bill_number: 7004, title: 'Cuba sanctions accountability act', news_query: null, status: 'committee', last_action_date: '2026-02-01' },
  ...Array.from({ length: 30 }, (_, i) => ({
    bill_type: 'hjres', bill_number: 500 + i, title: `A joint resolution to direct the President to proclaim observance week number ${i}`, news_query: null, status: 'committee', last_action_date: '2026-01-01',
  })),
  ...Array.from({ length: 30 }, (_, i) => ({
    bill_type: 'hr', bill_number: 9000 + i, title: `Rural broadband grant improvement measure number ${i} for counties`, news_query: null, status: 'committee', last_action_date: '2026-01-01',
  })),
];
const CORPUS = [...SIBLINGS, ...IRAN, ...OTHERS].map((b) => ({ congress_number: 119, press_names: null, ...b }));
const index = buildBillIndex(CORPUS);

// The floor record a 2026-09-25 morning run held: H.Con.Res. 89 listed on
// congress.gov's senate-floor-today feed (it was, in the 2026-09-24 session
// window and the 2026-09-25 pre window), plus S. 4668, which was on the same
// feed that week.
const NOW = Date.parse('2026-09-25T06:00:00Z');
const floorRecord = buildFloorRecord({
  persisted: rollFloorRecord(null, [
    { slug: 'hconres-89-119', source: 'senate-floor-today' },
    { slug: 's-4668-119', source: 'senate-floor-today' },
  ], Date.parse('2026-09-25T05:00:00Z')),
  nowMs: NOW,
});

test.describe('the 2026-09-24 Iran vote: the measure on the floor is offered, and offered first', () => {
  const VOTE = 'Senate rejects war powers resolution to end the Iran war';

  test('BEFORE (no floor record): an S.J.Res. leads and the voted measure is cut off the shortlist', () => {
    const slugs = slugsOf(matchLocal(VOTE, index));
    expect(slugs).toHaveLength(T3_CANDIDATES_MAX);
    expect(slugs[0]).not.toBe('hconres-89-119');
    expect(slugs).not.toContain('hconres-89-119');
  });

  test('AFTER: H.Con.Res. 89 is on the shortlist, first, carrying its floor record', () => {
    const cands = candsOf(matchLocal(VOTE, index, { floorRecord }));
    expect(cands[0].slug).toBe('hconres-89-119');
    expect(cands[0].floor).toMatchObject({ kind: 'floor', chamber: 'senate', date: '2026-09-25' });
  });

  test('the Fox-shaped headline, where the voted measure scored BELOW the candidate floor, still gets it', () => {
    // "rebel AGAINST Trump" matches the S.J.Res. wording's "within or against
    // … Iran"; H.Con.Res. 89 says "with Iran" and scores on "iran"/"war" only.
    const h = '4 GOP senators rebel against Trump on Iran war, vote with Dems to rein in authority';
    const cands = candsOf(matchLocal(h, index, { floorRecord }));
    expect(cands.map((c) => c.slug)).toContain('hconres-89-119');
    expect(cands[0].slug).toBe('hconres-89-119');
  });

  test('offering is not choosing: every other candidate t2 found is still offered', () => {
    const before = slugsOf(matchLocal(VOTE, index));
    const after = slugsOf(matchLocal(VOTE, index, { floorRecord }));
    for (const s of before) expect(after).toContain(s);
    expect(after.length).toBeLessThanOrEqual(T3_CANDIDATES_MAX + FLOOR_RESCUE_MAX);
  });

  test('a floor bill from a DIFFERENT family is never added to the Iran headline', () => {
    expect(slugsOf(matchLocal(VOTE, index, { floorRecord }))).not.toContain('s-4668-119');
  });

  test('a floor-record candidate never lands ahead of an unrelated candidate the headline supports better', () => {
    // The headline is about the oil-profits tax bill, which merely has "Iran
    // War" in its name; H.Con.Res. 89 may be offered, but not ahead of it.
    const h = 'House committee weighs Iran war oil crisis windfall profits tax bill';
    const r = matchLocal(h, index, { floorRecord });
    if (r?.tier === 't2') {
      expect(r.slug).toBe('hr-8803-119');
      return;
    }
    const slugs = slugsOf(r);
    expect(slugs[0]).toBe('hr-8803-119');
  });

  test('the floor record never makes a headline confident, and never touches a confident verdict', () => {
    const confident = 'Protect College Sports Act college sports athletes bill';
    expect(matchLocal(confident, index)).toEqual({ tier: 't2', slug: 's-4668-119' });
    expect(matchLocal(confident, index, { floorRecord })).toEqual({ tier: 't2', slug: 's-4668-119' });
    expect(matchLocal('Local weather turns cooler this weekend', index, { floorRecord })).toBeNull();
  });

  test('an empty or absent floor record is exactly the old behavior', () => {
    const plain = matchLocal(VOTE, index);
    expect(matchLocal(VOTE, index, {})).toEqual(plain);
    expect(matchLocal(VOTE, index, { floorRecord: new Map() })).toEqual(plain);
  });
});

test.describe('titleFamily (near-identical measures, counted on distinctive title words)', () => {
  const e = (slug: string) => index.bySlug?.get(slug);

  test('the S.J.Res. and H.Con.Res. Iran wordings are ONE family, though their raw word overlap is small', () => {
    expect(titleFamily(e('sjres-185-119'), e('hconres-89-119'), index.df)).toBe(true);
    expect(titleFamily(e('hconres-75-119'), e('hconres-89-119'), index.df)).toBe(true);
  });

  test('a bill that merely mentions Iran is not in the family', () => {
    expect(titleFamily(e('hr-8803-119'), e('hconres-89-119'), index.df)).toBe(false);
    expect(titleFamily(e('s-3281-119'), e('sjres-185-119'), index.df)).toBe(false);
  });

  test('a bill is not its own sibling, and missing entries are never family', () => {
    expect(titleFamily(e('hconres-89-119'), e('hconres-89-119'), index.df)).toBe(false);
    expect(titleFamily(undefined, e('hconres-89-119'), index.df)).toBe(false);
  });

  test('a family is a template, not a subject: every other country\'s war-powers resolution is in it too', () => {
    // Which is why a family alone never lets one member stand in for another.
    for (const s of ['sjres-98-119', 'sjres-124-119', 'hjres-153-119', 'hconres-61-119']) {
      expect(titleFamily(e('hconres-89-119'), e(s), index.df), s).toBe(true);
    }
  });
});

/*
 * A family is a template. The floor record may put one member in another's
 * place only where the HEADLINE cannot tell them apart. These pin that for
 * the case the first version of this change got wrong: with an Iran
 * resolution on the floor, Venezuela and Cuba coverage was routed to it (and
 * the reverse), for the 48 hours the floor record lasts.
 */
const recordOf = (slug: string) =>
  buildFloorRecord({ persisted: rollFloorRecord(null, [{ slug, source: 'senate-floor-today' }], NOW - 3_600_000), nowMs: NOW });

test.describe('another country\'s resolution keeps its own coverage while an Iran resolution is on the floor', () => {
  test('a Venezuela headline keeps the Venezuela resolution first; H.Con.Res. 89 never passes it', () => {
    const slugs = slugsOf(matchLocal('Senate blocks resolution to halt Venezuela hostilities', index, { floorRecord }));
    expect(slugs[0]).toBe('sjres-98-119');
    if (slugs.includes('hconres-89-119')) expect(slugs.indexOf('hconres-89-119')).toBeGreaterThan(slugs.indexOf('sjres-98-119'));
  });

  test('"Venezuela war powers resolution": the Venezuela resolution is on the shortlist, first (war powers is one name)', () => {
    const slugs = slugsOf(matchLocal('Senate rejects Venezuela war powers resolution', index, { floorRecord }));
    expect(slugs[0]).toBe('sjres-98-119');
  });

  test('a Cuba headline: the floor record breaks no tie against the resolution whose title says Cuba', () => {
    const slugs = slugsOf(matchLocal('House votes on Cuba war powers resolution', index, { floorRecord }));
    expect(slugs).toContain('sjres-124-119');
    expect(slugs[0]).not.toBe('hconres-89-119');
    if (slugs.includes('hconres-89-119')) expect(slugs.indexOf('hconres-89-119')).toBeGreaterThan(slugs.indexOf('sjres-124-119'));
    const cuba2 = slugsOf(matchLocal('Senate blocks resolution to halt Cuba hostilities', index, { floorRecord }));
    expect(cuba2[0]).not.toBe('hconres-89-119');
  });

  test('the reverse: with the Venezuela resolution on the floor, Iran coverage is never led by it', () => {
    const fr = recordOf('sjres-98-119');
    // Shares only "resolution" with the Iran candidates: not added at all.
    expect(slugsOf(matchLocal('Senate rejects Iran war powers resolution', index, { floorRecord: fr }))).not.toContain('sjres-98-119');
    for (const h of ['Senate blocks resolution to end Iran hostilities', 'Senate votes against Iran war powers resolution']) {
      expect(slugsOf(matchLocal(h, index, { floorRecord: fr }))[0], h).not.toBe('sjres-98-119');
    }
  });

  test('when the headline IS about the measure on the floor, it still leads', () => {
    expect(slugsOf(matchLocal('Senate rejects Venezuela war powers resolution', index, { floorRecord: recordOf('sjres-98-119') }))[0]).toBe('sjres-98-119');
    expect(slugsOf(matchLocal('Senate rejects Cuba war powers resolution', index, { floorRecord: recordOf('sjres-124-119') }))[0]).toBe('sjres-124-119');
    // "Western Hemisphere" is rare enough to make t2 confident on its own.
    const r = matchLocal('House rejects Western Hemisphere war powers resolution', index, { floorRecord: recordOf('hconres-61-119') });
    expect(r?.tier === 't2' ? r.slug : slugsOf(r)[0]).toBe('hconres-61-119');
  });
});

test.describe('headlineCannotSeparate (when a floor measure may stand in for its sibling)', () => {
  const e = (slug: string) => index.bySlug?.get(slug);
  const can = (h: string, f: string, s: string) => headlineCannotSeparate(tokenize(h), e(f), e(s), undefined, index, index.df);

  test('two wordings of the Iran resolution, on an Iran headline: cannot be told apart', () => {
    expect(can('Senate rejects Iran war powers resolution', 'hconres-89-119', 'sjres-185-119')).toBe(true);
  });

  test('"against" is template wording, not a subject: every S.J.Res. says "within or against", and H.Con.Res. 75 says it too', () => {
    expect(can('Senators vote against Iran war powers resolution', 'hconres-89-119', 'sjres-172-119')).toBe(true);
  });

  test('a country the headline names, in the sibling\'s title and not the floor measure\'s, separates them', () => {
    expect(can('Senate blocks resolution to halt Venezuela hostilities', 'hconres-89-119', 'sjres-98-119')).toBe(false);
    expect(can('Senate blocks resolution to halt Cuba hostilities', 'hconres-89-119', 'sjres-124-119')).toBe(false);
    expect(can('Senate blocks resolution to end Iran hostilities', 'sjres-98-119', 'sjres-185-119')).toBe(false);
  });

  test('sharing only a common word ("resolution") is not shared evidence', () => {
    expect(can('Senate rejects Iran war powers resolution', 'sjres-98-119', 'sjres-185-119')).toBe(false);
  });

  test('search phrasing never names a subject: S.J.Res. 200\'s news_query adds "military action"', () => {
    expect(can('Senate rejects war powers resolution to halt military action in Iran', 'hconres-89-119', 'sjres-200-119')).toBe(true);
  });

  test('not a family, or a missing entry: never', () => {
    expect(can('Iran war oil windfall tax', 'hconres-89-119', 'hr-8803-119')).toBe(false);
    expect(headlineCannotSeparate(tokenize('Iran war powers'), undefined, e('sjres-185-119'), undefined, index, index.df)).toBe(false);
  });
});

test.describe('PHRASE_UNITS: "war powers" is the name of one law, scored as one token', () => {
  const find = (h: string, slug: string) => scoreCandidates(h, index).find((c: { slug: string }) => c.slug === slug) as { weight: number; shared: number; matched: string[] } | undefined;

  test('the unit list is exactly what was measured', () => {
    expect(PHRASE_UNITS.map((u: readonly string[]) => [...u])).toEqual([['war', 'powers']]);
  });

  test('a resolution citing the War Powers Resolution gets ONE point for "war powers", not two', () => {
    const c = find('Senate rejects Iran war powers resolution', 'hconres-89-119');
    // iran + "war powers" + resolution
    expect(c?.weight).toBe(3);
    expect(c?.shared).toBe(3);
    expect(c?.matched).toEqual(expect.arrayContaining(['war', 'powers']));
  });

  test('a bill with only "war" in its title gets nothing from "war powers"; "the Iran war" still matches it', () => {
    expect(find('Senate rejects Iran war powers vote', 'hr-8803-119')).toBeUndefined();
    expect(find('Senators debate the cost of the Iran war', 'hr-8803-119')).toBeDefined();
  });

  test('tokenize itself is unchanged: both words are still tokens', () => {
    expect(tokenize('Iran war powers')).toEqual(['iran', 'war', 'powers']);
  });
});

test.describe('the floor record breaks ties the headline leaves', () => {
  const h = 'College sports bill advances in the Senate';

  test('equal support: the measure on the floor record goes first', () => {
    expect(slugsOf(matchLocal(h, index))[0]).toBe('s-3990-119');
    const cands = candsOf(matchLocal(h, index, { floorRecord }));
    expect(cands[0].slug).toBe('s-4668-119');
    expect(cands[0].weight).toBe(cands[1].weight);
  });
});

test.describe('rollFloorRecord (the 48-hour memory of the chamber floor feeds)', () => {
  const T = Date.parse('2026-09-25T12:00:00Z');

  test('merges this run, keeps what is inside the window, drops what aged out', () => {
    const prev = {
      'hconres-89-119': { source: 'senate-floor-today', last_seen: '2026-09-24T23:00:00.000Z' },
      'hr-1-119': { source: 'house-floor-today', last_seen: new Date(T - (FLOOR_RECORD_HOURS + 1) * 3_600_000).toISOString() },
    };
    const out = rollFloorRecord(prev, [{ slug: 's-4668-119', source: 'senate-floor-today' }], T);
    expect(Object.keys(out).sort()).toEqual(['hconres-89-119', 's-4668-119']);
    expect(out['s-4668-119'].last_seen).toBe(new Date(T).toISOString());
  });

  test('only floor-record sources count - most-viewed is not the floor', () => {
    const out = rollFloorRecord(
      { 'hr-2-119': { source: 'most-viewed-bills', last_seen: new Date(T).toISOString() } },
      [{ slug: 'hr-3-119', source: 'most-viewed-bills' }],
      T
    );
    expect(out).toEqual({});
  });

  test('a schedule sighting never overwrites a floor sighting still in the window; a floor sighting replaces a schedule one', () => {
    const prev = { 'hconres-93-119': { source: 'house-floor-today', last_seen: '2026-09-25T02:00:00.000Z' } };
    const kept = rollFloorRecord(prev, [{ slug: 'hconres-93-119', source: 'house-bills-this-week' }], T);
    expect(kept['hconres-93-119'].source).toBe('house-floor-today');
    const upgraded = rollFloorRecord(
      { 'hr-5-119': { source: 'house-bills-this-week', last_seen: '2026-09-25T02:00:00.000Z' } },
      [{ slug: 'hr-5-119', source: 'house-floor-today' }],
      T
    );
    expect(upgraded['hr-5-119']).toEqual({ source: 'house-floor-today', last_seen: new Date(T).toISOString() });
  });

  test('a corrupt, missing or future-stamped memory degrades to this run alone, and the input is never mutated', () => {
    for (const bad of [null, undefined, 'x', [1, 2], { 'hr-1-119': { source: 'senate-floor-today', last_seen: 'garbage' } }]) {
      expect(rollFloorRecord(bad, [], T)).toEqual({});
    }
    expect(rollFloorRecord({ 'hr-1-119': { source: 'senate-floor-today', last_seen: '2027-01-01T00:00:00Z' } }, [], T)).toEqual({});
    const prev = { 'hr-9-119': { source: 'senate-floor-today', last_seen: '2026-09-25T10:00:00.000Z' } };
    const snapshot = JSON.stringify(prev);
    rollFloorRecord(prev, [{ slug: 'hr-10-119', source: 'senate-floor-today' }], T);
    expect(JSON.stringify(prev)).toBe(snapshot);
  });

  test('stores only slugs, sources and timestamps - never feed content', () => {
    const out = rollFloorRecord(null, [{ slug: 'hr-7-119', source: 'senate-floor-today', title: 'SOME HEADLINE' } as never], T);
    expect(out).toEqual({ 'hr-7-119': { source: 'senate-floor-today', last_seen: new Date(T).toISOString() } });
  });
});

test.describe('buildFloorRecord (floor feeds + the chambers\' own announcements)', () => {
  const T = Date.parse('2026-09-25T12:00:00Z');

  test('floor feeds become kind floor, the House weekly schedule kind scheduled', () => {
    const rec = buildFloorRecord({
      persisted: {
        'hconres-89-119': { source: 'senate-floor-today', last_seen: '2026-09-24T23:00:00.000Z' },
        'hr-5-119': { source: 'house-bills-this-week', last_seen: '2026-09-25T11:00:00.000Z' },
      },
      nowMs: T,
    });
    expect(rec.get('hconres-89-119')).toEqual({ kind: 'floor', chamber: 'senate', date: '2026-09-24', source: 'senate-floor-today' });
    expect(rec.get('hr-5-119')).toMatchObject({ kind: 'scheduled', chamber: 'house' });
  });

  test('floor-signals.json announcements count while live; a stale (carried-forward) one does not', () => {
    const rec = buildFloorRecord({
      signals: {
        's-4668-119': { tier0: { source: 'daily-digest', chamber: 'senate', covers: '2026-09-28', certainty: 'consideration' }, stale: false },
        's-1-119': { tier0: { source: 'daily-digest', chamber: 'senate', covers: '2026-09-20' }, stale: true },
        's-2-119': { stale: false }, // no tier0 block - not an announcement
      },
      nowMs: T,
    });
    expect(rec.get('s-4668-119')).toEqual({ kind: 'announced', chamber: 'senate', date: '2026-09-28', source: 'daily-digest', certainty: 'consideration' });
    expect(rec.has('s-1-119')).toBe(false);
    expect(rec.has('s-2-119')).toBe(false);
  });

  test('having been on the floor outranks having been announced', () => {
    const rec = buildFloorRecord({
      persisted: { 's-4668-119': { source: 'senate-floor-today', last_seen: '2026-09-25T11:00:00.000Z' } },
      signals: { 's-4668-119': { tier0: { chamber: 'senate', covers: '2026-09-28' }, stale: false } },
      nowMs: T,
    });
    expect(rec.get('s-4668-119')?.kind).toBe('floor');
  });

  test('no inputs is an empty record, never a throw', () => {
    expect(buildFloorRecord().size).toBe(0);
    expect(buildFloorRecord({ persisted: 'junk' as never, signals: null, nowMs: T }).size).toBe(0);
  });
});

test.describe('buildT3Prompt (exactly what the Haiku call reads)', () => {
  const VOTE = 'Senate rejects war powers resolution to end the Iran war';
  const batch = [{ title: VOTE, candidates: candsOf(matchLocal(VOTE, index, { floorRecord })) }];
  const prompt = buildT3Prompt(batch, { today: '2026-09-25' });

  test('every candidate carries its latest action date and status, in words', () => {
    expect(prompt).toContain('sjres-185-119 = A joint resolution');
    expect(prompt).toContain('latest action 2026-06-24; status: floor action on record');
    expect(prompt).toContain('hconres-89-119 = Directing the President');
    expect(prompt).toContain('latest action 2026-07-23; status: passed one chamber');
  });

  test('the measure on the floor says so, with the chamber, the day and the government source', () => {
    expect(prompt).toContain("FLOOR RECORD: listed on the Senate floor by congress.gov's floor-today feed, last listed 2026-09-25");
    // Only the floor-record candidate carries the note.
    expect(prompt.match(/FLOOR RECORD:/g)).toHaveLength(1);
  });

  test('the date anchor and the two guard sentences are present', () => {
    expect(prompt.startsWith('Today is 2026-09-25 (UTC). ')).toBe(true);
    expect(prompt).toContain('A floor record is not evidence by itself');
    expect(prompt).toContain('If none fit, use null.');
    expect(prompt).toContain('Output STRICT JSON only');
  });

  test('the prompt is record facts and the headline - no outlet, no lean, no party word of its own', () => {
    const instruction = buildT3Prompt([], {});
    expect(instruction).not.toMatch(/\b(left|right|liberal|conservative|republican|democrat|gop|progressive)\b/i);
    expect(instruction).not.toMatch(/news\.google|foxnews|cbsnews|washington examiner/i);
  });

  test('floorNote wording per kind', () => {
    expect(floorNote(null)).toBeNull();
    expect(floorNote({ kind: 'scheduled', chamber: 'house', date: '2026-09-21' })).toBe("on the House's published weekly floor schedule, seen 2026-09-21");
    expect(floorNote({ kind: 'announced', chamber: 'senate', date: '2026-09-28', certainty: 'scheduled_vote' }))
      .toBe("announced for Senate floor action for 2026-09-28 in the chamber's own schedule (scheduled vote)");
  });

  test('a candidate with no date or status still formats (never "undefined")', () => {
    const line = formatT3Candidate({ slug: 'hr-1-119', title: 'X Act' });
    expect(line).toBe('hr-1-119 = X Act [latest action unknown; status: unknown]');
  });
});

test.describe('headlineForMatching (the aggregator\'s " - Outlet" suffix is not evidence)', () => {
  const GN = 'https://news.google.com/rss/articles/CBMiabc?oc=5';

  test('a Google News item loses the outlet name', () => {
    expect(headlineForMatching('Vulnerable Republicans stick with Trump to shoot down Senate Iran war powers vote - Washington Examiner', GN))
      .toBe('Vulnerable Republicans stick with Trump to shoot down Senate Iran war powers vote');
    expect(headlineForMatching('Despite Iran War Criticism, Vulnerable Senate Republicans Vote Against War Powers Resolution - nationalreview.com', GN))
      .toBe('Despite Iran War Criticism, Vulnerable Senate Republicans Vote Against War Powers Resolution');
  });

  test('only the LAST " - " is cut - a hyphenated headline keeps its own dash', () => {
    expect(headlineForMatching('Senate - House talks stall on stopgap - Roll Call', GN)).toBe('Senate - House talks stall on stopgap');
  });

  test('a direct feed title is untouched, dashes and all', () => {
    const t = 'Shutdown looms - and here is what happens next';
    expect(headlineForMatching(t, 'https://www.cbsnews.com/news/x/')).toBe(t);
    expect(headlineForMatching(t, 'not a url')).toBe(t);
    expect(headlineForMatching(t, undefined)).toBe(t);
  });

  test('a title that is ONLY the suffix shape is never emptied', () => {
    expect(headlineForMatching(' - Fox News', GN)).toBe('- Fox News');
  });

  test('the suffix used to change which bills a headline was matched to', () => {
    // "Review" (National Review) is a title word of every Congressional Review
    // Act disapproval resolution; "washington" and "post" are corpus words too.
    expect(tokenize('Senate votes - National Review')).toContain('review');
    expect(tokenize(headlineForMatching('Senate votes - National Review', GN))).not.toContain('review');
  });
});

test.describe('looksLegislative: the 2026-09-26 precision pass', () => {
  test('"White House" alone is not a chamber', () => {
    for (const h of [
      'Judge weighs lawsuit over White House ballroom construction',
      'CNN, MS NOW and Politico sue to restore White House access',
      'Trump welcomes Xi to White House for state dinner',
      'WHITE HOUSE SECURITY FENCE EXPANDED',
    ]) expect(looksLegislative(h), h).toBe(false);
  });

  test('a White House story that ALSO says a legislative word still passes, and so does the chamber', () => {
    expect(looksLegislative('White House urges Senate to pass crypto bill')).toBe(true);
    expect(looksLegislative('House passes stopgap as White House signals support')).toBe(true);
    expect(looksLegislative('House GOP unveils plan')).toBe(true);
  });

  test('NDAA, shutdown and CR are legislative signals', () => {
    expect(looksLegislative('Pentagon priorities as the NDAA takes shape')).toBe(true);
    expect(looksLegislative('Shutdown looms as talks stall')).toBe(true);
    expect(looksLegislative('Leaders eye a clean CR through December')).toBe(true);
  });

  test('CR counts only as the capitalized acronym', () => {
    expect(looksLegislative('cr tests the new phones')).toBe(false);
  });

  test('NIL was reviewed and NOT added (see the gate comment for the measurement)', () => {
    expect(looksLegislative('Star quarterback signs NIL deal with a restaurant chain')).toBe(false);
    // A NIL story about the bill still passes on its own words.
    expect(looksLegislative('Senate NIL bill advances')).toBe(true);
  });

  test('no party nouns were added - that widening is an open owner decision', () => {
    expect(looksLegislative('GOP leaders meet donors')).toBe(false);
    expect(looksLegislative('Democrats meet donors')).toBe(false);
  });
});

test.describe('tokenize keeps "war" (and only the short words it was measured for)', () => {
  test('"war" survives the length floor; other short scraps still drop', () => {
    expect(tokenize('Iran war powers vote')).toEqual(expect.arrayContaining(['iran', 'war', 'powers', 'vote']));
    expect(tokenize('GOP says new tax plan')).not.toEqual(expect.arrayContaining(['gop']));
    expect(tokenize('SEC and CR and NIL')).toEqual([]);
  });

  test('the keep-list is exactly what the replay measured', () => {
    expect([...SHORT_TOKENS_KEPT]).toEqual(['war']);
  });
});

/*
 * THE WIRING. newsdesk.mjs is an I/O script (it fetches and calls the model at
 * import), so - like the cost-invariance suite in newsdesk-match.unit.spec.ts
 * - these pin its source text: the pure pieces above are only worth anything if
 * the script actually calls them, with the right inputs, in the right place.
 */
test.describe('the floor record, the prompt and the t3 overflow are wired into scripts/newsdesk.mjs', () => {
  const src = readFileSync(join(process.cwd(), 'scripts/newsdesk.mjs'), 'utf8');

  test('t3 reads the pure prompt builder, with the run\'s own date - no inline prompt left behind', () => {
    expect(src).toMatch(/content: buildT3Prompt\(batch, \{ today \}\)/);
    expect(src).toMatch(/resolveWithHaiku\(anthropic, t3Batch, \{ today: todayUTC \}\)/);
    expect(src).not.toContain('For each numbered headline below');
  });

  test('every tier matches on headlineForMatching\'s view of the title, and t2 gets the floor record', () => {
    expect(src).toMatch(/const title = headlineForMatching\(it\.title, it\.link\);/);
    expect(src).toMatch(/findCitations\(title\)/);
    expect(src).toMatch(/matchLocal\(title, billIndex, \{ floorRecord \}\)/);
    expect(src).toMatch(/looksLegislative\(title\)/);
    expect(src).toMatch(/extractNicknameTokens\(headlineForMatching\(it\.title, it\.link\)\)/);
  });

  test('the seen-set still hashes the RAW title, so no dedupe key moved', () => {
    expect(src).toMatch(/cache\.seen\.add\(hashHeadline\(it\.title, it\.outlet\)\)/);
    expect(src).not.toMatch(/hashHeadline\(title,/);
  });

  test('t3 overflow is tracked, logged, and left out of the seen-set; the cap itself is unchanged', () => {
    expect(src).toMatch(/T3_MAX_HEADLINES = Number\(process\.env\.NEWSDESK_T3_MAX_HEADLINES \?\? 40\)/);
    expect(src).toMatch(/t3Overflow\.add\(it\)/);
    expect(src).toMatch(/if \(!t3Overflow\.has\(it\)\) cache\.seen\.add\(hashHeadline\(it\.title, it\.outlet\)\)/);
    expect(src).toContain('t3 overflow: ');
  });

  test('the t3 log line pipeline-health parses is byte-compatible', () => {
    // lib/pipeline-health.mjs parseT3: /^t3: (\d+) headline\(s\) batched.*?, (\d+) resolved/
    expect(src).toContain("console.log(`t3: ${t3Batch.length} headline(s) batched${t3Batch.length ? '' : ' (skipped - empty batch)'}, ${t3Results.size} resolved`);");
  });

  test('the floor record is built from the floor-record sources, the persisted memory and floor-signals.json', () => {
    expect(src).toMatch(/FLOOR_RECORD_SOURCES\[label\]/);
    expect(src).toMatch(/rollFloorRecord\(/);
    expect(src).toMatch(/buildFloorRecord\(\{ persisted: floorMemory, signals: floorSignals\?\.signals/);
    // Built BEFORE the matching loop that reads it.
    expect(src.indexOf('const floorRecord = buildFloorRecord(')).toBeLessThan(src.indexOf('matchLocal(title, billIndex, { floorRecord })'));
    // The floor-signals loader is still null-tolerant, and there is still exactly one.
    expect(src.match(/const floorSignals = \(\(\) => \{/g)).toHaveLength(1);
  });

  test('the floor record changes no budget: no decode cap or daily counter is read or written near it', () => {
    const block = src.slice(src.indexOf('const FLOOR_RECORD_FILE'), src.indexOf('const citationSlugs = new Set();'));
    expect(block).not.toMatch(/DECODE_CAP|dailyDecodes|decideFires|forceSlugs/);
  });
});
