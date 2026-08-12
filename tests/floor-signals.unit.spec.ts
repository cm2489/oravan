import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Pure, I/O-free module (no CONGRESS_API_KEY, no network, no fs) — see
// scripts/floor-signals-parse.mjs's header for the whole T0 design this pins.
import {
  alreadyDisposed,
  CARRY_FORWARD_MAX_DAYS,
  deriveSourceStatus,
  digestToText,
  entersFloorWatch,
  FLOOR_SIGNALS_SCHEMA,
  govinfoGranuleHtmlUrl,
  materialFingerprint,
  mergeSignals,
  parseBillsThisWeek,
  parseProgramBlocks,
  parseSenateProgram,
  programCertainty,
  QUOTE_MAX_CHARS,
  redecodeCandidates,
  redecodeVerdict,
  resolveMeetingDate,
  routeNomination,
  selectDigestGranule,
  sessionFromProgram,
  shouldWrite,
  splitProgramSentences,
  titleDrift,
  trackFromCategory,
  verifyFloorSignals,
} from '../scripts/floor-signals-parse.mjs';
// The gate this module's spend predicate must stay a SUPERSET of. Two
// different questions — see entersFloorWatch's doc comment — pinned against
// each other here so they can only ever drift in the safe direction.
import { floorPendingChamber } from '../lib/journey';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

// Real documents, fetched live 2026-08-12 and committed unmodified:
//   2026-08-04  a busy Senate program — the continuing-resolution vehicle, a
//               nomination, a conditional war-powers motion, an en-bloc line
//   2026-07-29  the day the digest ran four announcements into one paragraph
//   2026-08-10  a recess day, pro forma in both chambers
//   govinfo     the SAME 08-10 digest in the fallback's per-page shape
const DIGEST_0804 = fixture('crec-digest-2026-08-04.htm');
const DIGEST_0729 = fixture('crec-digest-2026-07-29.htm');
const DIGEST_PROFORMA = fixture('crec-digest-proforma-2026-08-10.htm');
const DIGEST_GOVINFO = fixture('crec-digest-govinfo-2026-08-10.htm');
const BILLS_THIS_WEEK = fixture('house-bills-this-week-20260720.xml');
const GRANULES = JSON.parse(fixture('govinfo-granules-CREC-2026-08-04.json'));

const URL_0804 = 'https://www.congress.gov/119/crec/2026/08/04/d04au6-1.htm';

/* ------------------------------------------------------------------ *
 * 1 · The digest, in both document shapes
 * ------------------------------------------------------------------ */
test.describe('parseProgramBlocks', () => {
  test('finds both chambers in congress.gov whole-digest HTML', () => {
    const blocks = parseProgramBlocks(digestToText(DIGEST_0804));
    expect(blocks.senate?.label).toBe('Program for Wednesday:');
    expect(blocks.senate?.meetingLabel).toBe('10:30 a.m., Wednesday, August 5');
    expect(blocks.senate?.proForma).toBe(false);
    expect(blocks.senate?.lines.length).toBe(4);
    expect(blocks.house?.proForma).toBe(true);
  });

  test('finds both chambers in the govinfo per-page granule shape', () => {
    // govinfo prints "Next Meeting of the SENATE" on ONE line; congress.gov
    // splits it across two. Both are the same heading.
    const blocks = parseProgramBlocks(digestToText(DIGEST_GOVINFO));
    expect(blocks.senate?.meetingLabel).toBe('8 a.m., Thursday, August 13');
    expect(blocks.senate?.proForma).toBe(true);
    expect(blocks.house?.proForma).toBe(true);
  });

  test('the two shapes of the SAME issue agree', () => {
    const primary = parseProgramBlocks(digestToText(DIGEST_PROFORMA));
    const fallback = parseProgramBlocks(digestToText(DIGEST_GOVINFO));
    expect(fallback.senate?.lines).toEqual(primary.senate?.lines);
    expect(fallback.house?.lines).toEqual(primary.house?.lines);
  });

  test("a printer's rule never lands inside a program block", () => {
    // govinfo closes each section with a run of underscores. Swallowing one
    // makes every-sentence-is-pro-forma false and turns a recess into
    // "the House is in session" — the exact miscall critic A-5 is about.
    const blocks = parseProgramBlocks(digestToText(DIGEST_GOVINFO));
    expect(blocks.house?.lines.some((l: string) => /^[_-]{5,}/.test(l))).toBe(false);
  });

  test('a document with no program blocks yields nulls, not guesses', () => {
    expect(parseProgramBlocks('Some other page entirely.')).toEqual({ senate: null, house: null });
  });
});

test.describe('resolveMeetingDate', () => {
  test('fills the year in from the issue date', () => {
    expect(resolveMeetingDate('10:30 a.m., Wednesday, August 5', '2026-08-04')).toBe('2026-08-05');
  });

  test('rolls over December -> January', () => {
    expect(resolveMeetingDate('9 a.m., Friday, January 3', '2026-12-30')).toBe('2027-01-03');
  });

  test('refuses a label with no date in it', () => {
    expect(resolveMeetingDate('Senate Chamber', '2026-08-04')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 2 · Sentence splitting — a quote must be an announcement, not a page
 * ------------------------------------------------------------------ */
test.describe('splitProgramSentences', () => {
  test('splits a real multi-announcement paragraph', () => {
    const blocks = parseProgramBlocks(digestToText(DIGEST_0729));
    const paragraph = blocks.senate.lines.find((l: string) => l.length > 500);
    expect(paragraph).toBeTruthy();
    const parts = splitProgramSentences(paragraph);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p: string) => p.endsWith('.'))).toBe(true);
    expect(parts.join(' ')).toBe(paragraph);
  });

  test('never cuts inside a citation ("S.J. Res. 199")', () => {
    for (const part of splitProgramSentences(
      'Senate will proceed to S.J. Res. 199, a resolution of disapproval. Senate will then recess.'
    )) {
      expect(part).not.toMatch(/Res\.$/);
    }
  });

  test('fails closed on a fragment that is not a whole announcement', () => {
    const line = 'Senate will vote. Ok.';
    expect(splitProgramSentences(line)).toEqual([line]);
  });

  test('a single sentence is returned unchanged', () => {
    const line = 'Senate will meet in a pro forma session.';
    expect(splitProgramSentences(line)).toEqual([line]);
  });
});

/* ------------------------------------------------------------------ *
 * 3 · Senate program -> signals (and owner ruling V3: nominations)
 * ------------------------------------------------------------------ */
const NOMINATIONS = [
  { citation: 'PN932', nominee_description: 'Erica Schwartz, of Florida, to be Director of the Centers for Disease Control and Prevention.', status: 'exec_calendar', exec_calendar_number: 412 },
  { citation: 'PN12-8', nominee_description: 'Walter Clayton, of New York, to be United States Attorney for the Southern District of New York.', status: 'confirmed', exec_calendar_number: null },
  { citation: 'PN1092', nominee_description: 'Walter Clayton, of New York, to be Director of National Intelligence, vice Tulsi Gabbard.', status: 'exec_calendar', exec_calendar_number: 501 },
];

function senateItems(html: string, issueDate: string, bySlug = new Map()) {
  const blocks = parseProgramBlocks(digestToText(html));
  return parseSenateProgram(blocks.senate, {
    issueDate,
    url: URL_0804,
    covers: resolveMeetingDate(blocks.senate.meetingLabel, issueDate),
    coversLabel: blocks.senate.meetingLabel,
    bySlug,
    nominations: NOMINATIONS,
  });
}

test.describe('parseSenateProgram', () => {
  test('names the bills the Senate named, with the verbatim sentence attached', () => {
    const { items } = senateItems(DIGEST_0804, '2026-08-04');
    const bills = items.filter((i: { kind: string }) => i.kind === 'bill');
    expect(bills.map((b: { slug: string }) => b.slug)).toEqual(['hr-6500-119', 'sjres-187-119']);
    const cr = bills[0];
    expect(cr.tier0.quote).toContain('H.R. 6500');
    // The quote is a contiguous substring of the document, not a summary of it.
    expect(digestToText(DIGEST_0804)).toContain(cr.tier0.quote);
    expect(cr.tier0.quote_lang).toBe('en');
    expect(cr.tier0.published).toBe('2026-08-04');
    expect(cr.tier0.covers).toBe('2026-08-05');
    expect(cr.tier0.covers_label).toBe('10:30 a.m., Wednesday, August 5');
    expect(cr.tier0.url).toBe(URL_0804);
  });

  test('a nomination NEVER enters the bill map (owner ruling V3)', () => {
    const { items } = senateItems(DIGEST_0804, '2026-08-04');
    const noms = items.filter((i: { kind: string }) => i.kind === 'nomination');
    expect(noms.map((n: { citation: string }) => n.citation)).toEqual(['PN932']);
    expect(items.filter((i: { kind: string }) => i.kind === 'bill').map((b: { slug: string }) => b.slug)).not.toContain('PN932');
  });

  test('an en-bloc nomination line is dropped with a reason, never guessed at', () => {
    const { dropped } = senateItems(DIGEST_0804, '2026-08-04');
    expect(dropped.map((d: { reason: string }) => d.reason)).toContain('nomination_unroutable');
  });

  test('a measure already finally disposed of is dropped, not crowned', () => {
    // The measured miss class: the program cites a resolution agreed to weeks
    // earlier because it is the standing order the day runs under.
    const bySlug = new Map([
      ['sjres-187-119', { status: 'signed', last_action_date: '2026-07-01' }],
    ]);
    const { items, dropped } = senateItems(DIGEST_0804, '2026-08-04', bySlug);
    expect(items.filter((i: { kind: string }) => i.kind === 'bill').map((b: { slug: string }) => b.slug)).toEqual(['hr-6500-119']);
    expect(dropped.some((d: { reason: string; slug?: string }) => d.reason === 'already_disposed' && d.slug === 'sjres-187-119')).toBe(true);
  });

  test('no quote ever exceeds the ceiling', () => {
    for (const html of [DIGEST_0804, DIGEST_0729]) {
      for (const item of senateItems(html, '2026-08-04').items) {
        expect(item.tier0.quote.length).toBeLessThanOrEqual(QUOTE_MAX_CHARS);
      }
    }
  });

  test('alreadyDisposed reads terminality against the digest’s own date', () => {
    expect(alreadyDisposed({ status: 'signed', last_action_date: '2026-07-01' }, '2026-08-04')).toBe(true);
    // Enacted AFTER the digest was published: the program was still a schedule
    // when it was printed, so it is not evidence of a stale citation.
    expect(alreadyDisposed({ status: 'signed', last_action_date: '2026-08-09' }, '2026-08-04')).toBe(false);
    expect(alreadyDisposed({ status: 'floor_vote', last_action_date: '2026-07-01' }, '2026-08-04')).toBe(false);
    expect(alreadyDisposed(undefined, '2026-08-04')).toBe(false);
  });

  test('a pro forma program yields nothing at all', () => {
    const blocks = parseProgramBlocks(digestToText(DIGEST_PROFORMA));
    expect(blocks.senate.proForma).toBe(true);
    expect(parseSenateProgram(blocks.senate, { issueDate: '2026-08-10', url: URL_0804, nominations: NOMINATIONS }).items).toEqual([]);
  });
});

test.describe('programCertainty', () => {
  test('reads the verb the Senate used, and nothing else', () => {
    expect(programCertainty('Senate will vote on the motion to invoke cloture at 11:30 a.m.')).toBe('scheduled_vote');
    expect(programCertainty('Senate will continue consideration of H.R. 6500, post-cloture.')).toBe('consideration');
    expect(programCertainty('If Senator Whitehouse or his designee makes a motion to proceed…')).toBe('conditional');
  });
});

test.describe('routeNomination', () => {
  test('routes on the executive calendar number', () => {
    expect(routeNomination('Senate will proceed to Executive Calendar #412, the nomination.', NOMINATIONS)).toEqual({
      citation: 'PN932',
      matchedOn: 'exec_calendar_number',
    });
  });

  test('disambiguates a repeated nominee by the office the digest names', () => {
    expect(
      routeNomination(
        'Senate will continue consideration of the nomination of Walter Clayton, of New York, to be Director of National Intelligence, post-cloture.',
        NOMINATIONS
      )
    ).toEqual({ citation: 'PN1092', matchedOn: 'nominee_name' });
  });

  test('returns null rather than guess when the record cannot break the tie', () => {
    const twins = [
      { citation: 'PN1', nominee_description: 'Alex Doe, of Ohio, to be Judge.', status: 'exec_calendar' },
      { citation: 'PN2', nominee_description: 'Alex Doe, of Ohio, to be Judge.', status: 'exec_calendar' },
    ];
    expect(routeNomination('the nomination of Alex Doe, of Ohio, to be Judge', twins)).toBeNull();
  });

  test('an en-bloc line names nobody and routes to nothing', () => {
    expect(
      routeNomination('Senate will vote on the motion to invoke cloture on the en bloc nominations, provided under the provisions of S. Res. 817 (119th Congress).', NOMINATIONS)
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 4 · billsthisweek — rule vs suspension (critic A-2)
 * ------------------------------------------------------------------ */
test.describe('parseBillsThisWeek', () => {
  const parsed = parseBillsThisWeek(BILLS_THIS_WEEK, { url: 'https://docs.house.gov/x.xml', weekOf: '2026-07-20' });

  test('keeps the House’s own section structure as the track marker', () => {
    const trackOf = (slug: string) =>
      parsed.items.find((i: { slug: string }) => i.slug === slug)?.tier0.track;
    expect(trackOf('hr-2715-119')).toBe('suspension');
    expect(trackOf('hconres-113-119')).toBe('rule');
    expect(new Set(parsed.items.map((i: { tier0: { track: string } }) => i.tier0.track))).toEqual(new Set(['suspension', 'rule', 'unspecified']));
  });

  test('carries the week it covers and a verbatim floor-text quote', () => {
    const item = parsed.items.find((i: { slug: string }) => i.slug === 'hr-2715-119');
    expect(item.tier0.source).toBe('billsthisweek');
    expect(item.tier0.chamber).toBe('house');
    expect(item.tier0.quote).toBe('Destruction of Hazardous Imports Act, as amended');
    expect(item.tier0.quote_lang).toBe('en');
    expect(item.tier0.announcement).toBe('Items that may be considered under suspension of the rules');
    expect(parsed.weekDate).toBe('2026-07-20');
  });

  test('scans only <legis-num> — a bill cited in prose never becomes a signal', () => {
    expect(BILLS_THIS_WEEK).toContain('H. Con. Res.____');
    expect(parsed.items.every((i: { slug: string }) => /^(hr|s|hjres|sjres|hconres|sconres)-\d+-119$/.test(i.slug))).toBe(true);
  });

  test('an item the House PULLED is dropped with a reason (critic A-1)', () => {
    const pulled = BILLS_THIS_WEEK.replace('remove-date=""', 'remove-date="2026-07-21T09:00:00"');
    const after = parseBillsThisWeek(pulled, { url: 'https://x', weekOf: '2026-07-20' });
    expect(after.items.length).toBe(parsed.items.length - 1);
    expect(after.dropped.some((d: { reason: string }) => d.reason === 'removed_from_schedule')).toBe(true);
  });
});

test.describe('trackFromCategory', () => {
  test('maps the three observed headings and guesses at nothing', () => {
    expect(trackFromCategory('Items that may be considered under suspension of the rules')).toBe('suspension');
    expect(trackFromCategory('Items that may be considered pursuant to a rule')).toBe('rule');
    expect(trackFromCategory('Items that may be considered')).toBe('unspecified');
    expect(trackFromCategory('Something new the House invented')).toBe('unspecified');
  });
});

/* ------------------------------------------------------------------ *
 * 5 · source_status — a 404 is never a quiet week on its own (A-5)
 * ------------------------------------------------------------------ */
test.describe('deriveSourceStatus', () => {
  test('a source that answered with measures is ok', () => {
    expect(deriveSourceStatus({ outcome: 'ok' })).toBe('ok');
  });

  test('a 404 WHILE the other source shows Congress meeting is data_stale, not quiet', () => {
    expect(deriveSourceStatus({ outcome: 'missing', crossCheck: 'in_session' })).toBe('data_stale');
  });

  test('a 404 with the chamber self-evidently out is quiet', () => {
    expect(deriveSourceStatus({ outcome: 'missing', selfEvidentQuiet: true, crossCheck: 'in_session' })).toBe('quiet');
    expect(deriveSourceStatus({ outcome: 'missing', crossCheck: 'out_of_session' })).toBe('quiet');
  });

  test('two dark sources produce unknown — never quiet', () => {
    expect(deriveSourceStatus({ outcome: 'missing', crossCheck: 'unknown' })).toBe('unknown');
    expect(deriveSourceStatus({ outcome: 'empty', crossCheck: 'unknown' })).toBe('unknown');
  });

  test('a thrown fetch is always an error', () => {
    expect(deriveSourceStatus({ outcome: 'error', selfEvidentQuiet: true, crossCheck: 'out_of_session' })).toBe('error');
  });
});

test.describe('sessionFromProgram', () => {
  test('reads pro forma as out, business as in, absence as unknown', () => {
    const proforma = parseProgramBlocks(digestToText(DIGEST_PROFORMA));
    const busy = parseProgramBlocks(digestToText(DIGEST_0804));
    expect(sessionFromProgram(proforma.senate)).toBe('out_of_session');
    expect(sessionFromProgram(busy.senate)).toBe('in_session');
    expect(sessionFromProgram(null)).toBe('unknown');
  });
});

/* ------------------------------------------------------------------ *
 * 6 · merge + write policy (critic A-1)
 * ------------------------------------------------------------------ */
const NOW = Date.parse('2026-08-05T12:00:00Z');
const ok = { 'daily-digest': { status: 'ok' }, billsthisweek: { status: 'ok' } };
const dark = { 'daily-digest': { status: 'error' }, billsthisweek: { status: 'error' } };

const entry = (source: string, extra: Record<string, unknown> = {}) => ({
  tier0: { source, quote: 'Senate will vote.', quote_lang: 'en', url: 'https://x/y', published: '2026-08-04', covers: '2026-08-05', ...extra },
  fetched_at: '2026-08-05T11:00:00Z',
  first_seen: '2026-08-01T11:00:00Z',
  stale: false,
});

test.describe('mergeSignals', () => {
  test('a source that answered and did not name a bill drops it the same hour', () => {
    const merged = mergeSignals({
      previous: { signals: { 'hr-1-119': entry('daily-digest') } },
      fetched: [],
      sourceStates: ok,
      now: NOW,
    });
    expect(merged.signals['hr-1-119']).toBeUndefined();
  });

  test('a source that FAILED carries its signals forward, marked stale', () => {
    const merged = mergeSignals({
      previous: { signals: { 'hr-1-119': entry('daily-digest') } },
      fetched: [],
      sourceStates: dark,
      now: NOW,
    });
    expect(merged.signals['hr-1-119'].stale).toBe(true);
  });

  test('carry-forward stops once the announcement’s own day has passed', () => {
    const merged = mergeSignals({
      previous: { signals: { 'hr-1-119': entry('daily-digest', { covers: '2026-08-01' }) } },
      fetched: [],
      sourceStates: dark,
      now: NOW,
    });
    expect(merged.signals['hr-1-119']).toBeUndefined();
  });

  test('carry-forward stops after CARRY_FORWARD_MAX_DAYS even if the day it covers is still ahead', () => {
    const old = {
      ...entry('daily-digest', { covers: '2026-09-01' }),
      fetched_at: new Date(NOW - (CARRY_FORWARD_MAX_DAYS + 1) * 86_400_000).toISOString(),
    };
    const merged = mergeSignals({ previous: { signals: { 'hr-1-119': old } }, fetched: [], sourceStates: dark, now: NOW });
    expect(merged.signals['hr-1-119']).toBeUndefined();
  });

  test('first_seen survives a re-observation; fetched_at moves', () => {
    const merged = mergeSignals({
      previous: { signals: { 'hr-1-119': entry('daily-digest') } },
      fetched: [{ kind: 'bill', slug: 'hr-1-119', tier0: entry('daily-digest').tier0 }],
      sourceStates: ok,
      now: NOW,
    });
    expect(merged.signals['hr-1-119'].first_seen).toBe('2026-08-01T11:00:00Z');
    expect(merged.signals['hr-1-119'].fetched_at).toBe(new Date(NOW).toISOString());
    expect(merged.signals['hr-1-119'].stale).toBe(false);
  });

  test('nominations land in their own map, never among the bills', () => {
    const merged = mergeSignals({
      previous: null,
      fetched: [{ kind: 'nomination', citation: 'PN932', tier0: entry('daily-digest').tier0 }],
      sourceStates: ok,
      now: NOW,
    });
    expect(Object.keys(merged.signals)).toEqual([]);
    expect(Object.keys(merged.nominations)).toEqual(['PN932']);
  });
});

test.describe('shouldWrite', () => {
  const doc = (signals: Record<string, unknown>, fetchedAt: string) => ({
    _meta: { schema: FLOOR_SIGNALS_SCHEMA, fetched_at: fetchedAt, sources: {} },
    signals,
    nominations: {},
  });

  test('writes when the schedule changed', () => {
    const previous = doc({}, new Date(NOW - 60_000).toISOString());
    const next = doc({ 'hr-1-119': entry('daily-digest') }, new Date(NOW).toISOString());
    expect(shouldWrite({ previous, next, now: NOW })).toBe(true);
  });

  test('stays silent on an unchanged run with a fresh stamp — an hourly cron is not an hourly deploy', () => {
    const previous = doc({ 'hr-1-119': entry('daily-digest') }, new Date(NOW - 3_600_000).toISOString());
    const next = doc({ 'hr-1-119': entry('daily-digest') }, new Date(NOW).toISOString());
    expect(shouldWrite({ previous, next, now: NOW })).toBe(false);
  });

  test('re-stamps an aged file that is still claiming something', () => {
    const previous = doc({ 'hr-1-119': entry('daily-digest') }, new Date(NOW - 7 * 3_600_000).toISOString());
    const next = doc({ 'hr-1-119': entry('daily-digest') }, new Date(NOW).toISOString());
    expect(shouldWrite({ previous, next, now: NOW })).toBe(true);
  });

  test('never re-stamps an empty file — a recess produces no commits at all', () => {
    const previous = doc({}, new Date(NOW - 30 * 3_600_000).toISOString());
    const next = doc({}, new Date(NOW).toISOString());
    expect(shouldWrite({ previous, next, now: NOW })).toBe(false);
  });

  test('materialFingerprint ignores timestamps and nothing else', () => {
    const a = doc({ 'hr-1-119': entry('daily-digest') }, '2026-08-05T01:00:00Z');
    const b = doc({ 'hr-1-119': { ...entry('daily-digest'), fetched_at: '2026-08-05T09:00:00Z' } }, '2026-08-05T09:00:00Z');
    expect(materialFingerprint(a)).toBe(materialFingerprint(b));
  });
});

/* ------------------------------------------------------------------ *
 * 7 · the re-decode trigger (design A6 + critic A-8)
 * ------------------------------------------------------------------ */
test.describe('titleDrift', () => {
  test('the measured vehicle swap is a swap', () => {
    expect(
      titleDrift(
        'AGOA Extension Act of 2026',
        'Continuing Appropriations and Extensions Act, 2027'
      ).swapped
    ).toBe(true);
  });

  test('ordinary title wobble is not', () => {
    expect(titleDrift('Destruction of Hazardous Imports Act', 'Destruction of Hazardous Imports Act, as amended').swapped).toBe(false);
    expect(titleDrift('SEED Act', 'SEED Act').swapped).toBe(false);
  });

  test('an unknown title on either side never declares a swap', () => {
    expect(titleDrift(null, 'Anything').swapped).toBe(false);
    expect(titleDrift('Anything', null).swapped).toBe(false);
  });
});

test.describe('redecodeVerdict', () => {
  test('fires when the decode predates the record', () => {
    expect(redecodeVerdict({ decodedAt: '2026-07-01T10:00:00Z', lastActionDate: '2026-08-04', corpusTitle: 'A', fetchedTitle: 'A' })).toMatchObject({ redecode: true, reason: 'stale-decode' });
  });

  test('does NOT fire on a same-day decode', () => {
    expect(redecodeVerdict({ decodedAt: '2026-08-04T23:00:00Z', lastActionDate: '2026-08-04' })).toMatchObject({ redecode: false, reason: 'fresh-decode' });
  });

  test('fires on a vehicle swap even with no decode stamp at all', () => {
    expect(
      redecodeVerdict({ decodedAt: null, lastActionDate: '2026-08-04', corpusTitle: 'AGOA Extension Act of 2026', fetchedTitle: 'Continuing Appropriations and Extensions Act, 2027' })
    ).toMatchObject({ redecode: true, reason: 'vehicle-swap' });
  });

  test('A-8: a null stamp with a matching title is skipped, not re-decoded', () => {
    // The whole pre-2026-08-12 corpus is null. Reading unknown as old would
    // have spent a day’s tier-0 cap re-explaining decodes that were fine.
    expect(redecodeVerdict({ decodedAt: null, lastActionDate: '2026-08-04', corpusTitle: 'A', fetchedTitle: 'A' })).toMatchObject({ redecode: false, reason: 'null-decoded-at' });
    expect(redecodeVerdict({ decodedAt: null, lastActionDate: '2026-08-04' })).toMatchObject({ redecode: false, reason: 'null-decoded-at' });
  });

  test('a bill with no last action is left alone', () => {
    expect(redecodeVerdict({ decodedAt: '2026-01-01T00:00:00Z', lastActionDate: null })).toMatchObject({ redecode: false, reason: 'no-last-action' });
  });
});

test.describe('entersFloorWatch', () => {
  test('catches the four rungs the site already speaks in', () => {
    expect(entersFloorWatch('Cloture motion on the motion to proceed to the measure presented in Senate. (CR S4365)')).toBe(true);
    expect(entersFloorWatch('Motion to proceed to consideration of measure made in Senate.')).toBe(true);
    expect(entersFloorWatch('Considered as unfinished business. POSTPONED PROCEEDINGS')).toBe(true);
    expect(entersFloorWatch('Rules Committee Resolution H. Res. 900 Reported to House.')).toBe(true);
  });

  test('catches the two rungs the backtest measured as gaps (K7)', () => {
    expect(entersFloorWatch('Cloture on the motion to proceed to the measure invoked in Senate by Yea-Nay Vote. 86 - 12.')).toBe(true);
    expect(entersFloorWatch('Motion to proceed to measure considered in Senate.')).toBe(true);
    expect(entersFloorWatch('Measure laid before Senate by motion.')).toBe(true);
  });

  test('never fires on a settled record', () => {
    expect(entersFloorWatch('Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 52 - 46.')).toBe(false);
    expect(entersFloorWatch('Motion to proceed to consideration of measure rejected in Senate.')).toBe(false);
    expect(entersFloorWatch(null)).toBe(false);
  });

  test('is a strict SUPERSET of lib/journey.ts’s pending gate, over the live corpus', () => {
    // The spend gate may be wider than the claim gate; it may never be
    // narrower, or a bill the site is about to crown could be explained from
    // a document it has outgrown.
    const corpus: { last_action_text: string | null }[] = JSON.parse(
      readFileSync(join(__dirname, '..', 'data', 'bills.json'), 'utf8')
    );
    const missed = corpus.filter((b) => floorPendingChamber(b.last_action_text) && !entersFloorWatch(b.last_action_text));
    expect(missed.map((b) => b.last_action_text)).toEqual([]);
  });
});

test.describe('redecodeCandidates', () => {
  const bills = [
    { bill_type: 'hr', bill_number: 6500, congress_number: 119, last_action_date: '2026-08-04', last_action_text: 'Message on Senate action sent to the House.' },
    { bill_type: 'hr', bill_number: 3633, congress_number: 119, last_action_date: '2026-08-08', last_action_text: 'Cloture motion on the motion to proceed to the measure presented in Senate.' },
    { bill_type: 's', bill_number: 5271, congress_number: 119, last_action_date: '2026-08-08', last_action_text: 'Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 52 - 46.' },
    { bill_type: 's', bill_number: 347, congress_number: 119, last_action_date: '2025-02-05', last_action_text: 'Motion to proceed to consideration of measure made in Senate.' },
  ];
  const now = Date.parse('2026-08-09T00:00:00Z');

  test('T0 first, then T1, newest action first', () => {
    const out = redecodeCandidates({ signals: { 'hr-6500-119': { stale: false } }, bills, now });
    expect(out.map((c: { slug: string; tier: string }) => [c.slug, c.tier])).toEqual([
      ['hr-6500-119', 't0'],
      ['hr-3633-119', 't1'],
    ]);
  });

  test('a stale carried-forward signal does not put a bill at the front of the queue', () => {
    const out = redecodeCandidates({ signals: { 'hr-6500-119': { stale: true } }, bills, now });
    expect(out.map((c: { slug: string }) => c.slug)).toEqual(['hr-3633-119']);
  });

  test('a settled defeat and an aged motion are both out', () => {
    const slugs = redecodeCandidates({ signals: {}, bills, now }).map((c: { slug: string }) => c.slug);
    expect(slugs).not.toContain('s-5271-119'); // the floor already answered
    expect(slugs).not.toContain('s-347-119'); // 18 months old
  });

  test('honors its cap', () => {
    expect(redecodeCandidates({ signals: {}, bills, now, cap: 1 }).length).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 8 · govinfo fallback selection
 * ------------------------------------------------------------------ */
test.describe('selectDigestGranule', () => {
  test('picks the granule whose title carries the program, not the first digest page', () => {
    expect(selectDigestGranule(GRANULES)).toBe('CREC-2026-08-04-pt1-PgD809');
    expect(selectDigestGranule({ granules: [] })).toBeNull();
  });

  test('builds the no-key HTML URL', () => {
    expect(govinfoGranuleHtmlUrl('CREC-2026-08-04', 'CREC-2026-08-04-pt1-PgD809')).toBe(
      'https://www.govinfo.gov/content/pkg/CREC-2026-08-04/html/CREC-2026-08-04-pt1-PgD809.htm'
    );
  });
});

/* ------------------------------------------------------------------ *
 * 9 · the gate
 * ------------------------------------------------------------------ */
test.describe('verifyFloorSignals', () => {
  const good = {
    _meta: { schema: FLOOR_SIGNALS_SCHEMA, fetched_at: '2026-08-05T12:00:00Z', sources: { 'daily-digest': { status: 'ok' } } },
    signals: { 'hr-6500-119': entry('daily-digest') },
    nominations: {},
  };

  test('passes a well-formed file', () => {
    expect(verifyFloorSignals({ data: good, fileBytes: 1000, now: NOW }).failures).toEqual([]);
  });

  test('rejects a signal with no quote', () => {
    const bad = { ...good, signals: { 'hr-6500-119': { ...entry('daily-digest'), tier0: { ...entry('daily-digest').tier0, quote: '  ' } } } };
    expect(verifyFloorSignals({ data: bad, fileBytes: 1000, now: NOW }).failures.join(' ')).toContain('no quote');
  });

  test('rejects a TRANSLATED quote (owner ruling V4)', () => {
    const bad = { ...good, signals: { 'hr-6500-119': { ...entry('daily-digest'), tier0: { ...entry('daily-digest').tier0, quote_lang: 'es' } } } };
    expect(verifyFloorSignals({ data: bad, fileBytes: 1000, now: NOW }).failures.join(' ')).toContain('quote_lang');
  });

  test('rejects an unknown schema, an unknown source and a future date', () => {
    expect(verifyFloorSignals({ data: { ...good, _meta: { ...good._meta, schema: 'floor-signals/v9' } }, fileBytes: 10, now: NOW }).failures.join(' ')).toContain('unknown _meta.schema');
    expect(verifyFloorSignals({ data: { ...good, signals: { x: { ...entry('mystery-feed') } } }, fileBytes: 10, now: NOW }).failures.join(' ')).toContain('unknown source');
    expect(verifyFloorSignals({ data: { ...good, signals: { x: { ...entry('daily-digest'), tier0: { ...entry('daily-digest').tier0, published: '2099-01-01' } } } }, fileBytes: 10, now: NOW }).failures.join(' ')).toContain('in the future');
  });

  test('rejects a runaway file', () => {
    expect(verifyFloorSignals({ data: good, fileBytes: 9_000_000, now: NOW }).failures.join(' ')).toContain('ceiling');
  });

  test('warns — never fails — on a bill the corpus does not hold yet', () => {
    const { failures, warnings } = verifyFloorSignals({ data: good, fileBytes: 1000, now: NOW, knownSlugs: new Set() });
    expect(failures).toEqual([]);
    expect(warnings.join(' ')).toContain('hr-6500-119');
  });

  test('reads the committed file cleanly', () => {
    const committed = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'floor-signals.json'), 'utf8'));
    expect(verifyFloorSignals({ data: committed, fileBytes: 1000 }).failures).toEqual([]);
  });
});
