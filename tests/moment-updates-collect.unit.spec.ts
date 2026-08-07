import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The pure half of the collector. ZERO network in this file — every input is
// either a committed fixture captured from the live API or a literal built
// from a shape this repo already verified. scripts/moment-updates.mjs itself
// is deliberately NOT imported: it opens data/, shells out to git, fetches
// Congress.gov, and constructs an Anthropic client at module scope.
import {
  CONGRESS,
  MILESTONE_PATTERNS,
  actionToCandidate,
  billLabel,
  classifyAction,
  clusterIsPublishable,
  congressGovUrlForSlug,
  dailyEventCount,
  fallbackTextFor,
  floorScheduleItems,
  floorTodayItems,
  leanOf,
  milestoneOf,
  momentVehicles,
  normalizeSource,
  outletDisplayName,
  pressClusterToCandidate,
  quotedRecordText,
  scheduledToCandidate,
  slugParts,
  statusDiffToCandidate,
  suppressRedundantStatusChanges,
} from '../scripts/moment-updates-map.mjs';
import {
  extractBillsThisWeekSlugs,
  extractFloorFeedSlugs,
} from '../scripts/newsdesk-match.mjs';
import {
  RECORD_EVENT_CLASSES,
  computeUpdateId,
  dedupeUpdates,
  lintUpdateText,
} from '../lib/moment-updates-gate.mjs';
// The TypeScript matcher whose normalizeSource this module duplicates. Both
// are imported here so the drift pin can compare them directly.
import { normalizeSource as tsNormalizeSource } from '../lib/coverage';

const repo = (p: string) => join(__dirname, '..', p);
const read = (p: string) => JSON.parse(readFileSync(repo(p), 'utf8'));
const readText = (p: string) => readFileSync(repo(p), 'utf8');

type Action = Record<string, unknown>;
const actionsOf = (file: string): Action[] => read(`tests/fixtures/${file}`).actions;

const HR9770 = actionsOf('congress-actions-hr9770.json');
const HCONRES89 = actionsOf('congress-actions-hconres89.json');
const SJRES185 = actionsOf('congress-actions-sjres185.json');

const find = (actions: Action[], needle: string) =>
  actions.find((a) => String(a.text ?? '').includes(needle)) as Action;

/** The parts of a Congress.gov action this suite reaches into. */
type RecordedVote = { chamber: string; rollNumber: number; date: string; url: string };
const rollOf = (a: Action) => (a.recordedVotes as RecordedVote[])[0].rollNumber;
const voteDateOf = (a: Action) => (a.recordedVotes as RecordedVote[])[0].date;
const systemOf = (a: Action) => (a.sourceSystem as { name: string }).name;

/** One stored/candidate update. The .mjs modules are typed only by JSDoc, so
 *  callback parameters over their return values get this shape explicitly. */
type Localized = { en: string; es: string };
type Update = {
  id: string;
  class: string;
  vehicle: string;
  day: string;
  occurred_at: string;
  occurred_precision: string;
  recorded_at: string;
  text: Localized | null;
  source: { kind: string; refs: string[]; outlets?: string[]; outlet_names?: string[]; lean_set?: string[] };
  record: {
    action_text: string;
    action_code: string | null;
    action_type: string | null;
    source_system: string | null;
    roll_call?: { chamber: string; number: number };
    status_from?: string | null;
    status_to?: string | null;
  } | null;
  ai: boolean;
};
type FeedItem = { slug: string; addDate?: string | null };
type Article = { source?: string; url?: string; publishedAt?: string };
/** dedupeUpdates is JSDoc-typed as Record<string, any>[]; narrow it once here. */
const asUpdates = (rows: unknown) => rows as Update[];

/* ------------------------------------------------------------------ *
 * 1 · The fixtures ARE the live API (captured 2026-07-25).
 * ------------------------------------------------------------------ */
test.describe('fixtures', () => {
  test('carry the real payload shape the collector maps', () => {
    for (const actions of [HR9770, HCONRES89, SJRES185]) {
      expect(actions.length).toBeGreaterThan(0);
      for (const a of actions) {
        expect(typeof a.actionDate).toBe('string');
        expect(typeof a.text).toBe('string');
      }
    }
  });

  test('the LOC echo really is present, with a DIFFERENT code and DIFFERENT text', () => {
    // This is the finding the whole identity rule exists for (v2 spec §4).
    const chamber = find(HR9770, 'On passage Passed by the Yeas and Nays: 220 - 205');
    const echo = find(HR9770, 'Passed/agreed to in House');
    expect(chamber.actionCode).toBe('H37100');
    expect(echo.actionCode).toBe('8000');
    expect(chamber.text).not.toBe(echo.text);
    expect(rollOf(chamber)).toBe(rollOf(echo));
    expect(systemOf(chamber)).toBe('House floor actions');
    expect(systemOf(echo)).toBe('Library of Congress');
  });

  test('Senate actions carry a NULL actionCode — the case the key must tolerate', () => {
    const received = find(HR9770, 'Received in the Senate.');
    expect(received.actionCode).toBeUndefined();
    expect(systemOf(received)).toBe('Senate');
  });

  test('CONGRESS matches the tracked Congress every other script uses', () => {
    expect(CONGRESS).toBe(119);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · Slug helpers.
 * ------------------------------------------------------------------ */
test.describe('slug helpers', () => {
  test('billLabel renders every tracked type in citation form', () => {
    expect(billLabel('hr-9770-119')).toBe('H.R. 9770');
    expect(billLabel('s-4784-119')).toBe('S. 4784');
    expect(billLabel('hjres-12-119')).toBe('H.J.Res. 12');
    expect(billLabel('sjres-185-119')).toBe('S.J.Res. 185');
    expect(billLabel('hconres-89-119')).toBe('H. Con. Res. 89');
    expect(billLabel('sconres-3-119')).toBe('S. Con. Res. 3');
  });

  test('congressGovUrlForSlug uses the right chamber path per type', () => {
    // hconres/sconres were the 2026-07-23 bug: they used to get a
    // senate-joint-resolution path. Pinned here so the collector's refs can't
    // regress into a 404.
    expect(congressGovUrlForSlug('hconres-89-119')).toBe(
      'https://www.congress.gov/bill/119th-congress/house-concurrent-resolution/89',
    );
    expect(congressGovUrlForSlug('sjres-185-119')).toBe(
      'https://www.congress.gov/bill/119th-congress/senate-joint-resolution/185',
    );
    expect(congressGovUrlForSlug('hr-9770-119')).toBe('https://www.congress.gov/bill/119th-congress/house-bill/9770');
  });

  test('the URLs the collector emits are the ones the real corpus stores', () => {
    const bills: { full_identifier: string; congress_gov_url: string }[] = read('data/bills.json');
    const moments = read('data/moments.json');
    const wanted = new Set(momentVehicles(moments).map((v: { slug: string }) => v.slug));
    let checked = 0;
    for (const b of bills) {
      if (!wanted.has(b.full_identifier)) continue;
      expect(congressGovUrlForSlug(b.full_identifier), b.full_identifier).toBe(b.congress_gov_url);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  test('slugParts splits into the API path pieces', () => {
    expect(slugParts('hconres-89-119')).toEqual({ type: 'hconres', number: '89' });
  });
});

/* ------------------------------------------------------------------ *
 * 3 · momentVehicles — scope, and only scope.
 * ------------------------------------------------------------------ */
test.describe('momentVehicles', () => {
  test('pairs every non-retired moment with each of its vehicles', () => {
    const pairs = momentVehicles({
      a: { status: 'live', vehicles: [{ slug: 'hr-1-119' }, { slug: 's-2-119' }] },
      b: { status: 'live', vehicles: [{ slug: 'hr-1-119' }] },
    });
    expect(pairs).toEqual([
      { momentId: 'a', slug: 'hr-1-119' },
      { momentId: 'a', slug: 's-2-119' },
      { momentId: 'b', slug: 'hr-1-119' },
    ]);
  });

  test('a retired moment is out of scope entirely', () => {
    // v2 spec §4 deletes a retired moment's updates; collecting new ones would
    // write rows the very next prune throws away.
    const pairs = momentVehicles({
      live: { status: 'live', vehicles: [{ slug: 'hr-1-119' }] },
      gone: { status: 'retired', vehicles: [{ slug: 's-2-119' }] },
    });
    expect(pairs).toEqual([{ momentId: 'live', slug: 'hr-1-119' }]);
  });

  test('the real data/moments.json resolves to real corpus slugs', () => {
    const moments = read('data/moments.json');
    const bills: { full_identifier: string }[] = read('data/bills.json');
    const slugs = new Set(bills.map((b) => b.full_identifier));
    const pairs = momentVehicles(moments);
    expect(pairs.length).toBeGreaterThan(0);
    for (const { slug } of pairs) expect(slugs.has(slug), slug).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 4 · SELECTION — classifyAction over the live fixtures.
 * ------------------------------------------------------------------ */
test.describe('classifyAction', () => {
  test('a recorded vote is always a vote, in either chamber', () => {
    expect(classifyAction(find(HR9770, 'Roll no. 272'))).toBe('vote');
    expect(classifyAction(find(HCONRES89, 'Roll no. 282'))).toBe('vote');
    expect(classifyAction(find(SJRES185, 'Record Vote Number: 192'))).toBe('vote');
  });

  test('the LOC echo also classifies as a vote — dedupe collapses it, not the classifier', () => {
    expect(classifyAction(find(HR9770, 'Passed/agreed to in House'))).toBe('vote');
  });

  test('a chamber transfer is a floor_action even with a null actionCode', () => {
    expect(classifyAction(find(HR9770, 'Received in the Senate.'))).toBe('floor_action');
    expect(classifyAction(find(HCONRES89, 'Received in the Senate and referred'))).toBe('floor_action');
  });

  test('a Senate calendar placement is a floor_action', () => {
    expect(classifyAction(find(SJRES185, 'Placed on Senate Legislative Calendar'))).toBe('floor_action');
  });

  test('procedural bookkeeping does NOT become an update', () => {
    // Not suppressed because it is inconvenient — suppressed because rendering
    // it would pad a timeline with motion that is not movement (v2 spec §3).
    for (const needle of [
      'Motion to reconsider laid on the table',
      'The previous question was ordered',
      'DEBATE - The House proceeded',
      'Considered under the provisions of rule',
      'Introduced in House',
    ]) {
      expect(classifyAction(find(HR9770, needle)), needle).toBeNull();
    }
    expect(classifyAction(find(HCONRES89, 'Consideration initiated pursuant'))).toBeNull();
    expect(classifyAction(find(SJRES185, 'Read twice and referred'))).toBeNull();
  });

  test('every MILESTONE_PATTERNS entry names the milestone it matches', () => {
    for (const p of MILESTONE_PATTERNS) {
      expect(typeof p.key).toBe('string');
      expect(p.key.length).toBeGreaterThan(0);
      expect(p.re instanceof RegExp).toBe(true);
    }
    expect(milestoneOf({ text: 'Received in the Senate.' })).toBe('chamber_transfer');
    expect(milestoneOf({ text: 'Cloture motion on the measure presented in Senate.' })).toBe('cloture');
    expect(milestoneOf({ text: 'Ordered to be Reported by Voice Vote.' })).toBe('committee_action');
    expect(milestoneOf({ text: 'Became Public Law No: 119-42.' })).toBe('enactment');
    expect(milestoneOf({ text: 'DEBATE - one hour of debate.' })).toBeNull();
  });

  test('the whole hr-9770 fixture selects exactly the citizen-legible events', () => {
    // 16 real actions in; 4 out. The two survivors that are not the seeded
    // pair are the LOC echo of the passage vote (collapsed later by identity)
    // and the House adopting the rule that put the bill on the floor.
    const selected = HR9770.filter((a) => classifyAction(a) !== null).map((a) => String(a.text));
    expect(HR9770).toHaveLength(16);
    expect(selected).toHaveLength(4);
    expect(selected.some((t) => t === 'Received in the Senate.')).toBe(true);
    expect(selected.some((t) => t.startsWith('On passage Passed by the Yeas and Nays: 220 - 205'))).toBe(true);
    expect(selected.some((t) => t.startsWith('Passed/agreed to in House:'))).toBe(true);
    expect(selected.some((t) => t === 'Rule H. Res. 1438 passed House.')).toBe(true);
  });

  test('the whole hconres-89 fixture selects exactly the two seeded events plus the echo', () => {
    const selected = HCONRES89.filter((a) => classifyAction(a) !== null).map((a) => String(a.text));
    expect(HCONRES89).toHaveLength(15);
    expect(selected).toHaveLength(3);
    expect(selected.some((t) => t.startsWith('Received in the Senate and referred'))).toBe(true);
    expect(selected.some((t) => t.startsWith('On agreeing to the resolution Agreed to by the Yeas and Nays: 214 - 208'))).toBe(true);
    expect(selected.some((t) => t.startsWith('Passed/agreed to in House:'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 5 · actionToCandidate.
 * ------------------------------------------------------------------ */
test.describe('actionToCandidate', () => {
  const build = (action: Action) =>
    actionToCandidate({
      momentId: 'government-funding-deadline',
      vehicle: 'hr-9770-119',
      action,
      billUrl: congressGovUrlForSlug('hr-9770-119'),
      recordedAt: '2026-07-25T06:20:00Z',
    });

  test('a roll-call vote carries the tally, the roll call, and the clerk URL as a second ref', () => {
    const c = build(find(HR9770, 'Roll no. 272'))!;
    expect(c.class).toBe('vote');
    expect(c.day).toBe('2026-07-21');
    expect(c.occurred_at).toBe('2026-07-21');
    expect(c.occurred_precision).toBe('day');
    expect(c.record.action_text).toContain('220 - 205');
    expect(c.record.action_code).toBe('H37100');
    expect(c.record.roll_call).toEqual({ chamber: 'house', number: 272 });
    expect(c.source.kind).toBe('congress_actions');
    expect(c.source.refs).toEqual([
      'https://www.congress.gov/bill/119th-congress/house-bill/9770',
      'https://clerk.house.gov/evs/2026/roll272.xml',
    ]);
    expect(c.ai).toBe(false);
    expect(c.text).toBeNull();
  });

  test('day is actionDate VERBATIM — never re-derived from actionTime', () => {
    // The 22:14 ET vote carries a 02:14Z recordedVotes date on the FOLLOWING
    // UTC day. Bucketing by that would file Tuesday night's vote on Wednesday.
    const action = find(HR9770, 'Roll no. 272');
    expect(voteDateOf(action)).toBe('2026-07-22T02:14:39Z');
    expect(build(action)!.day).toBe('2026-07-21');
  });

  test('a Senate-source action with no actionCode still produces a well-formed record', () => {
    const c = build(find(HR9770, 'Received in the Senate.'))!;
    expect(c.class).toBe('floor_action');
    expect(c.record.action_code).toBeNull();
    expect(c.record.action_type).toBe('IntroReferral');
    expect(c.record.source_system).toBe('Senate');
    expect(c.record.roll_call).toBeUndefined();
    expect(c.source.refs).toHaveLength(1);
  });

  test('procedural noise maps to null, not to an empty update', () => {
    expect(build(find(HR9770, 'The previous question was ordered'))).toBeNull();
  });

  test('the id is the gate’s own recipe, re-derivable from the stored row', () => {
    const c = build(find(HR9770, 'Roll no. 272'))!;
    expect(c.id).toMatch(/^u_[0-9a-f]{8}$/);
    expect(computeUpdateId('government-funding-deadline', c)).toBe(c.id);
  });

  test('it reproduces the committed seed rows byte-for-byte on the fields that matter', () => {
    // The seed was hand-authored in slice S2 from this same API response. If
    // the collector cannot re-derive those ids, the very first live run would
    // duplicate every seeded event instead of deduping it.
    const seed = read('data/moment-updates.json');
    const seededVote = seed['government-funding-deadline'].updates.find((u: Update) => u.class === 'vote');
    const rebuilt = build(find(HR9770, 'Roll no. 272'))!;
    expect(rebuilt.id).toBe(seededVote.id);
    expect(rebuilt.record.action_text).toBe(seededVote.record.action_text);
    expect(rebuilt.record.roll_call).toEqual(seededVote.record.roll_call);

    const seededFloor = seed['government-funding-deadline'].updates.find((u: Update) => u.class === 'floor_action');
    const rebuiltFloor = build(find(HR9770, 'Received in the Senate.'))!;
    expect(rebuiltFloor.id).toBe(seededFloor.id);

    const iran = actionToCandidate({
      momentId: 'iran-war-powers',
      vehicle: 'hconres-89-119',
      action: find(HCONRES89, 'Roll no. 282'),
      billUrl: congressGovUrlForSlug('hconres-89-119'),
      recordedAt: '2026-07-25T06:20:00Z',
    })!;
    expect(iran.id).toBe(seed['iran-war-powers'].updates.find((u: Update) => u.vehicle === 'hconres-89-119' && u.class === 'vote').id);

    const senateVote = actionToCandidate({
      momentId: 'iran-war-powers',
      vehicle: 'sjres-185-119',
      action: find(SJRES185, 'Record Vote Number: 192'),
      billUrl: congressGovUrlForSlug('sjres-185-119'),
      recordedAt: '2026-07-25T06:20:00Z',
    })!;
    expect(senateVote.id).toBe(seed['iran-war-powers'].updates.find((u: Update) => u.vehicle === 'sjres-185-119').id);
    expect(senateVote.record.roll_call).toEqual({ chamber: 'senate', number: 192 });
  });
});

/* ------------------------------------------------------------------ *
 * 6 · The LOC-echo suppression, end to end through dedupeUpdates.
 * ------------------------------------------------------------------ */
test.describe('LOC-echo suppression', () => {
  const buildAll = (actions: Action[], momentId: string, vehicle: string) =>
    actions
      .map((a) => actionToCandidate({ momentId, vehicle, action: a, recordedAt: '2026-07-25T06:20:00Z' }))
      .filter(Boolean);

  test('the chamber record and the LOC echo collapse to ONE update, chamber wins', () => {
    const candidates = buildAll(HR9770, 'government-funding-deadline', 'hr-9770-119');
    const votes = candidates.filter((c: Update) => c.class === 'vote');
    expect(votes).toHaveLength(2); // both classify — the collapse is dedupe's job

    const merged = asUpdates(dedupeUpdates([], candidates));
    const mergedVotes = merged.filter((u: Update) => u.class === 'vote');
    expect(mergedVotes).toHaveLength(1);
    expect(mergedVotes[0].record!.source_system).toBe('House floor actions');
    expect(mergedVotes[0].record!.action_code).toBe('H37100');
    expect(mergedVotes[0].record!.action_text).not.toContain('Passed/agreed to in House');
  });

  test('the collapse is order-independent', () => {
    const candidates = buildAll(HR9770, 'government-funding-deadline', 'hr-9770-119');
    const forward = asUpdates(dedupeUpdates([], candidates)).map((u: Update) => u.id);
    const backward = asUpdates(dedupeUpdates([], [...candidates].reverse())).map((u: Update) => u.id);
    expect(backward).toEqual(forward);
  });

  test('the Senate-side echo collapses too (sjres-185, roll 129, code 14500 vs no code)', () => {
    const candidates = buildAll(SJRES185, 'iran-war-powers', 'sjres-185-119');
    const discharge = candidates.filter((c: Update) => c.record?.roll_call?.number === 129);
    expect(discharge).toHaveLength(2);
    const merged = asUpdates(dedupeUpdates([], candidates)).filter((u: Update) => u.record?.roll_call?.number === 129);
    expect(merged).toHaveLength(1);
    expect(merged[0].record!.source_system).toBe('Senate');
  });

  test('re-running the same collection twice adds nothing', () => {
    const candidates = buildAll(HCONRES89, 'iran-war-powers', 'hconres-89-119');
    const first = asUpdates(dedupeUpdates([], candidates));
    const second = asUpdates(dedupeUpdates(first, candidates));
    expect(second.map((u: Update) => u.id)).toEqual(first.map((u: Update) => u.id));
  });
});

/* ------------------------------------------------------------------ *
 * 7 · statusDiffToCandidate.
 * ------------------------------------------------------------------ */
test.describe('statusDiffToCandidate', () => {
  const before = { status: 'floor_vote', last_action_date: '2026-07-21', last_action_text: 'On passage Passed.' };
  const after = { status: 'passed_chamber', last_action_date: '2026-07-22', last_action_text: 'Received in the Senate.' };
  const args = { momentId: 'government-funding-deadline', vehicle: 'hr-9770-119', billUrl: congressGovUrlForSlug('hr-9770-119'), recordedAt: '2026-07-25T06:20:00Z' };

  test('a real move produces a status_change carrying the verbatim latest action', () => {
    const c = statusDiffToCandidate({ ...args, before, after })!;
    expect(c.class).toBe('status_change');
    expect(c.day).toBe('2026-07-22');
    expect(c.record.action_text).toBe('Received in the Senate.');
    expect(c.record.status_from).toBe('floor_vote');
    expect(c.record.status_to).toBe('passed_chamber');
    expect(c.source.kind).toBe('congress_actions');
  });

  test('no move produces nothing at all', () => {
    expect(statusDiffToCandidate({ ...args, before: after, after })).toBeNull();
  });

  test('a whitespace-only re-render of the same action text is not a move', () => {
    const reflowed = { ...after, last_action_text: '  Received   in the Senate.  ' };
    expect(statusDiffToCandidate({ ...args, before: after, after: reflowed })).toBeNull();
  });

  test('a missing last_action_date produces nothing — no honest day exists', () => {
    expect(statusDiffToCandidate({ ...args, before, after: { ...after, last_action_date: null } })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 8 · The status_change / action collision.
 * ------------------------------------------------------------------ */
test.describe('suppressRedundantStatusChanges', () => {
  test('one event seen from two angles renders once — the richer record wins', () => {
    const action = actionToCandidate({
      momentId: 'government-funding-deadline',
      vehicle: 'hr-9770-119',
      action: find(HR9770, 'Received in the Senate.'),
      recordedAt: '2026-07-25T06:20:00Z',
    })!;
    const diff = statusDiffToCandidate({
      momentId: 'government-funding-deadline',
      vehicle: 'hr-9770-119',
      before: { status: 'floor_vote', last_action_date: '2026-07-21', last_action_text: 'On passage Passed.' },
      after: { status: 'passed_chamber', last_action_date: '2026-07-22', last_action_text: 'Received in the Senate.' },
      recordedAt: '2026-07-25T06:20:00Z',
    })!;

    const kept = suppressRedundantStatusChanges([diff, action]);
    expect(kept).toEqual([action]);
  });

  test('a status_change on a DIFFERENT day survives', () => {
    const action = actionToCandidate({
      momentId: 'government-funding-deadline',
      vehicle: 'hr-9770-119',
      action: find(HR9770, 'Received in the Senate.'),
      recordedAt: '2026-07-25T06:20:00Z',
    })!;
    const diff = statusDiffToCandidate({
      momentId: 'government-funding-deadline',
      vehicle: 'hr-9770-119',
      before: { status: 'committee', last_action_date: '2026-07-18', last_action_text: 'Referred to committee.' },
      after: { status: 'floor_vote', last_action_date: '2026-07-21', last_action_text: 'Placed on the calendar.' },
      recordedAt: '2026-07-25T06:20:00Z',
    })!;
    expect(suppressRedundantStatusChanges([diff, action])).toHaveLength(2);
  });

  test('it never drops a vote or a floor_action', () => {
    const candidates = HR9770.map((a) =>
      actionToCandidate({ momentId: 'm', vehicle: 'hr-9770-119', action: a, recordedAt: '2026-07-25T06:20:00Z' }),
    ).filter(Boolean);
    expect(suppressRedundantStatusChanges(candidates)).toEqual(candidates);
    for (const c of candidates) expect(RECORD_EVENT_CLASSES).toContain((c as Update).class);
  });
});

/* ------------------------------------------------------------------ *
 * 9 · Tier-0 feeds -> scheduled, and the record-beats-signal rule.
 * ------------------------------------------------------------------ */
test.describe('tier-0 feed extraction', () => {
  const WEEK_XML = readText('tests/fixtures/house-bills-this-week-20260720.xml');
  // Real capture, 2026-07-25 (a Saturday): the House floor feed is genuinely
  // empty on a non-session day. Committed as the no-op proof.
  const EMPTY_FLOOR_XML = readText('tests/fixtures/house-floor-today-empty.xml');
  // The non-empty floor-feed shape, reproduced from this repo's own live
  // capture of 2026-07-23 (tests/newsdesk-match.unit.spec.ts) — the floor
  // feeds carry no items on the day these fixtures were taken.
  const FLOOR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>House Floor Today</title>
<item><title>H.R.9770</title><description><![CDATA[Continuing Appropriations Act, 2027 (07/23/2026)]]></description><link>https://www.congress.gov/bill/119th-congress/house-bill/9770</link></item>
<item><title>H.Con.Res.89</title><description><![CDATA[War powers resolution]]></description><link>https://www.congress.gov/bill/119th-congress/house-concurrent-resolution/89</link></item>
</channel></rss>`;

  test('DRIFT PIN: floorTodayItems yields exactly extractFloorFeedSlugs’ slug set', () => {
    expect(floorTodayItems(FLOOR_XML).map((i: FeedItem) => i.slug)).toEqual(extractFloorFeedSlugs(FLOOR_XML));
    expect(floorTodayItems(EMPTY_FLOOR_XML).map((i: FeedItem) => i.slug)).toEqual(extractFloorFeedSlugs(EMPTY_FLOOR_XML));
  });

  test('floorTodayItems adds the verbatim label a slug-only parser cannot carry', () => {
    const [first] = floorTodayItems(FLOOR_XML);
    expect(first.slug).toBe('hr-9770-119');
    expect(first.label).toBe('H.R.9770');
    expect(first.description).toBe('Continuing Appropriations Act, 2027 (07/23/2026)');
    expect(first.link).toBe('https://www.congress.gov/bill/119th-congress/house-bill/9770');
    expect(first.feedTitle).toBe('House Floor Today');
  });

  test('an empty (non-session) floor feed is a clean no-op', () => {
    expect(floorTodayItems(EMPTY_FLOOR_XML)).toEqual([]);
  });

  test('DRIFT PIN: floorScheduleItems yields exactly extractBillsThisWeekSlugs’ slug set', () => {
    const mine = [...new Set(floorScheduleItems(WEEK_XML).map((i: FeedItem) => i.slug))].sort();
    expect(mine).toEqual([...extractBillsThisWeekSlugs(WEEK_XML)].sort());
  });

  test('floorScheduleItems carries the government’s own strings for the record', () => {
    const items = floorScheduleItems(WEEK_XML);
    const hr9770 = items.find((i: FeedItem) => i.slug === 'hr-9770-119')!;
    expect(hr9770.legisNum).toBe('H.R. 9770');
    expect(hr9770.floorText).toBe('Continuing Appropriations Act, 2027');
    expect(hr9770.addDate).toBe('2026-07-16');
    expect(hr9770.weekDate).toBe('2026-07-20');
    expect(typeof hr9770.category).toBe('string');
  });

  test('addDate is the DATE PART only — the stamp carries no timezone', () => {
    // docs.house.gov stamps these ET-local with no offset; parsing one as an
    // instant would let an early-morning addition file on the previous ET day.
    expect(WEEK_XML).toContain('add-date="2026-07-16T10:09:15.633"');
    expect(floorScheduleItems(WEEK_XML).find((i: FeedItem) => i.slug === 'hr-9770-119')!.addDate).toBe('2026-07-16');
  });

  test('scheduledToCandidate emits a tier0_feed update with a non-null record', () => {
    const item = floorScheduleItems(WEEK_XML).find((i: FeedItem) => i.slug === 'hr-9770-119')!;
    const c = scheduledToCandidate({
      momentId: 'government-funding-deadline',
      vehicle: 'hr-9770-119',
      day: item.addDate as string,
      actionText: `${item.legisNum} — ${item.floorText}`,
      actionType: item.category,
      sourceSystem: `docs.house.gov floor schedule, week of ${item.weekDate}`,
      refs: ['https://docs.house.gov/billsthisweek/20260720/20260720.xml'],
      recordedAt: '2026-07-25T06:20:00Z',
    })!;
    expect(c.class).toBe('scheduled');
    expect(c.source.kind).toBe('tier0_feed');
    expect(c.record.action_text).toBe('H.R. 9770 — Continuing Appropriations Act, 2027');
    expect(c.day).toBe('2026-07-16');
  });

  test('a non-https ref is refused — a citation that cannot be checked is not a citation', () => {
    expect(
      scheduledToCandidate({
        momentId: 'm',
        vehicle: 'hr-9770-119',
        day: '2026-07-16',
        actionText: 'H.R. 9770',
        sourceSystem: 'x',
        refs: ['http://docs.house.gov/insecure.xml'],
      }),
    ).toBeNull();
  });

  test('SCHEDULED SUPPRESSION: a same-day record event beats the signal', () => {
    const vote = actionToCandidate({
      momentId: 'government-funding-deadline',
      vehicle: 'hr-9770-119',
      action: find(HR9770, 'Roll no. 272'),
      recordedAt: '2026-07-25T06:20:00Z',
    })!;
    const sched = scheduledToCandidate({
      momentId: 'government-funding-deadline',
      vehicle: 'hr-9770-119',
      day: vote.day, // the same legislative day
      actionText: 'H.R.9770 — Continuing Appropriations Act, 2027',
      sourceSystem: 'Congress.gov house-floor-today RSS',
      refs: ['https://www.congress.gov/rss/house-floor-today.xml'],
      recordedAt: '2026-07-25T06:20:00Z',
    })!;

    const merged = asUpdates(dedupeUpdates([], [sched, vote]));
    expect(merged.map((u: Update) => u.class)).toEqual(['vote']);
  });

  test('a scheduled signal on a day with no record event survives', () => {
    const vote = actionToCandidate({
      momentId: 'government-funding-deadline',
      vehicle: 'hr-9770-119',
      action: find(HR9770, 'Roll no. 272'),
      recordedAt: '2026-07-25T06:20:00Z',
    })!;
    const sched = scheduledToCandidate({
      momentId: 'government-funding-deadline',
      vehicle: 'hr-9770-119',
      day: '2026-07-16',
      actionText: 'H.R. 9770 — Continuing Appropriations Act, 2027',
      sourceSystem: 'docs.house.gov floor schedule',
      refs: ['https://docs.house.gov/billsthisweek/20260720/20260720.xml'],
      recordedAt: '2026-07-25T06:20:00Z',
    })!;
    expect(dedupeUpdates([], [sched, vote])).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * 10 · normalizeSource DRIFT PIN + press clusters.
 * ------------------------------------------------------------------ */
test.describe('normalizeSource drift pin', () => {
  // An .mjs script cannot import TypeScript, so this module carries a copy of
  // lib/coverage.ts's matcher. Same discipline check-moments.mjs applies to
  // TERMINAL_VEHICLE_STATUSES: one copy, or a test that proves the copies
  // agree. If the coverage matcher ever changes, this goes red before a
  // cluster can be attributed to the wrong outlet.
  const INPUTS = [
    'https://www.CNN.com/politics/x',
    'www.foxnews.com',
    'NPR.org',
    '  thehill.com  ',
    'http://politico.com/congress/2026/story',
    'chir.georgetown.edu',
    'example.com/',
    '',
    'HTTPS://WWW.NYTIMES.COM/',
  ];

  test('the .mjs copy and lib/coverage.ts agree on every form', () => {
    for (const input of INPUTS) {
      expect(normalizeSource(input), JSON.stringify(input)).toBe(tsNormalizeSource(input));
    }
  });

  test('it also agrees across every source string in the real coverage corpus', () => {
    const coverage: Record<string, { source?: string }[]> = read('data/coverage.json');
    let checked = 0;
    for (const [slug, articles] of Object.entries(coverage)) {
      if (slug.startsWith('_') || !Array.isArray(articles)) continue;
      for (const a of articles) {
        expect(normalizeSource(a.source ?? ''), a.source).toBe(tsNormalizeSource(a.source ?? ''));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

test.describe('press clusters', () => {
  const COVERAGE = read('tests/fixtures/coverage-sjres185.json')['sjres-185-119'];
  const LEANS = read('data/media-bias.json').outlets;
  const onDay = (day: string) => COVERAGE.filter((a: Article) => a.publishedAt === day);
  const build = (day: string, articles = onDay(day)) =>
    pressClusterToCandidate({
      momentId: 'iran-war-powers',
      vehicle: 'sjres-185-119',
      day,
      articles,
      leanByDomain: LEANS,
      recordedAt: '2026-07-25T06:20:00Z',
    });

  test('a lean-free two-outlet day publishes, with attribution attached', () => {
    // Real rows: khaama.com + juancole.com on 2026-06-04, neither AllSides-rated.
    const c = build('2026-06-04')!;
    expect(c.class).toBe('press_cluster');
    expect(c.record).toBeNull();
    expect(c.source.kind).toBe('press');
    expect(c.source.outlets).toEqual(['juancole.com', 'khaama.com']);
    expect(c.source.outlet_names).toEqual(['Juancole', 'Khaama']);
    expect(c.source.refs).toHaveLength(2);
    for (const r of c.source.refs) expect(r).toMatch(/^https:\/\//);
    expect(c.source.lean_set).toEqual([]);
  });

  test('a SINGLE-LEAN day is refused outright', () => {
    // Real rows: jns.org (unrated) + dailycaller.com (right) on 2026-06-23.
    // The inherited guardrail: never a single-lean channel (v2 spec §5).
    expect(build('2026-06-23')).toBeNull();
  });

  test('a one-outlet day is refused — a single outlet is not a cluster', () => {
    expect(build('2026-05-20')).toBeNull();
  });

  test('two articles from the SAME domain are still one outlet', () => {
    const dup = [
      { source: 'jns.org', url: 'https://jns.org/a', publishedAt: '2026-06-23' },
      { source: 'https://www.jns.org/b', url: 'https://jns.org/b', publishedAt: '2026-06-23' },
    ];
    expect(build('2026-06-23', dup)).toBeNull();
  });

  test('clusterIsPublishable mirrors coverageTier: cross and neutral publish, one-sided does not', () => {
    expect(clusterIsPublishable(['left', 'right'])).toBe(true);
    expect(clusterIsPublishable([null, null])).toBe(true);
    expect(clusterIsPublishable(['center', null])).toBe(true);
    expect(clusterIsPublishable(['right', null])).toBe(false);
    expect(clusterIsPublishable(['left'])).toBe(false);
  });

  test('lean_set is recorded, deduped and sorted, when the outlets are rated', () => {
    const cross = build('2026-07-24', [
      { source: 'foxnews.com', url: 'https://foxnews.com/a', publishedAt: '2026-07-24' },
      { source: 'truthout.org', url: 'https://truthout.org/b', publishedAt: '2026-07-24' },
      { source: 'npr.org', url: 'https://npr.org/c', publishedAt: '2026-07-24' },
    ])!;
    expect(cross.source.lean_set).toEqual(['center', 'left', 'right']);
    expect(cross.source.outlet_names).toEqual(['Fox News', 'NPR', 'Truthout']);
  });

  test('lean_set is a SET, not a fourth parallel column — never zip it against outlets', () => {
    // `refs`, `outlets` and `outlet_names` are positional and same-length by
    // construction; `lean_set` deliberately is not, which is why it carries
    // `_set` in its name. Four outlets, two of them AllSides-left, collapse to
    // three distinct leans. Asserted as a PROPERTY rather than as a value, so
    // a future "fix" that makes this positional has to argue with a test that
    // explains why it isn't — mis-zipping would attach a lean to the wrong
    // outlet on a Moment surface, which components/MomentTimeline.tsx's
    // ATTRIBUTION, NEVER LEAN promise forbids outright.
    const shared = build('2026-07-24', [
      { source: 'foxnews.com', url: 'https://foxnews.com/a', publishedAt: '2026-07-24' },
      { source: 'truthout.org', url: 'https://truthout.org/b', publishedAt: '2026-07-24' },
      { source: 'cnn.com', url: 'https://cnn.com/c', publishedAt: '2026-07-24' },
      { source: 'npr.org', url: 'https://npr.org/d', publishedAt: '2026-07-24' },
    ])!;
    expect(shared.source.outlets).toHaveLength(4);
    expect(shared.source.outlet_names).toHaveLength(4);
    expect(shared.source.refs).toHaveLength(4);
    expect(shared.source.lean_set!.length).not.toBe(shared.source.outlets!.length);
    expect(shared.source.lean_set).toEqual(['center', 'left', 'right']);
  });

  test('leanOf reads the AllSides table through the shared normalizer', () => {
    expect(leanOf('https://www.foxnews.com/politics/x', LEANS)).toBe('right');
    expect(leanOf('cnn.com', LEANS)).toBe('left');
    expect(leanOf('nowhere.example', LEANS)).toBeNull();
  });

  test('outletDisplayName knows the feed basket and falls back deterministically', () => {
    expect(outletDisplayName('thehill.com')).toBe('The Hill');
    expect(outletDisplayName('https://www.foxnews.com/x')).toBe('Fox News');
    expect(outletDisplayName('npr.org')).toBe('NPR');
    expect(outletDisplayName('khaama.com')).toBe('Khaama');
    expect(outletDisplayName('someoutlet.co.uk')).toBe('Someoutlet');
  });
});

/* ------------------------------------------------------------------ *
 * 11 · The non-AI fallback text.
 * ------------------------------------------------------------------ */
test.describe('fallback text', () => {
  test('the record is quoted, which is what makes it lint-safe AND honest', () => {
    // "SAVE America Act" is a real bill name that appears in real action text
    // and would trip the inherited `save` rule unquoted. Quoting is both
    // accurate typography and the exemption lib/moments-gate.mjs already grants.
    const raw = 'Rule provides for consideration of H.R. 7296, the SAVE America Act, under a closed rule.';
    expect(lintUpdateText(raw, 'en', 'floor_action')).not.toEqual([]);
    const quoted = quotedRecordText(raw);
    expect(quoted.startsWith('“')).toBe(true);
    expect(quoted.endsWith('”')).toBe(true);
    expect(lintUpdateText(quoted, 'en', 'floor_action')).toEqual([]);
  });

  test('inner double quotes are downgraded so the exemption span cannot break', () => {
    const quoted = quotedRecordText('Committee on "Crisis Response" reported the bill.');
    expect(quoted).not.toContain('"');
    expect(lintUpdateText(quoted, 'en', 'floor_action')).toEqual([]);
  });

  test('an over-long record is cut inside the quote, with an ellipsis', () => {
    const long = 'A'.repeat(400);
    const quoted = quotedRecordText(long);
    expect(quoted.length).toBeLessThanOrEqual(200);
    expect(quoted).toContain('…');
  });

  test('every real fixture action passes the lint through the fallback path', () => {
    for (const [actions, vehicle] of [
      [HR9770, 'hr-9770-119'],
      [HCONRES89, 'hconres-89-119'],
      [SJRES185, 'sjres-185-119'],
    ] as const) {
      for (const a of actions) {
        const c = actionToCandidate({ momentId: 'm', vehicle, action: a, recordedAt: '2026-07-25T06:20:00Z' });
        if (!c) continue;
        const text = fallbackTextFor(c);
        expect(lintUpdateText(text.en, 'en', c.class), c.record.action_text).toEqual([]);
        expect(lintUpdateText(text.es, 'es', c.class), c.record.action_text).toEqual([]);
      }
    }
  });

  test('a press cluster falls back to a flat, attributed sentence in both languages', () => {
    const c = pressClusterToCandidate({
      momentId: 'iran-war-powers',
      vehicle: 'sjres-185-119',
      day: '2026-07-24',
      // Cross-spectrum, so the cluster is publishable at all: a right outlet
      // and a left one. Both domains are real AllSides-rated entries.
      articles: [
        { source: 'foxnews.com', url: 'https://foxnews.com/a' },
        { source: 'truthout.org', url: 'https://truthout.org/b' },
      ],
      leanByDomain: read('data/media-bias.json').outlets,
      recordedAt: '2026-07-25T06:20:00Z',
    })!;
    const text = fallbackTextFor(c);
    expect(text.en).toContain('Fox News');
    expect(text.es).toContain('Fox News');
    // The attribution layer must be satisfied in EACH language.
    expect(lintUpdateText(text.en, 'en', 'press_cluster', c.source.outlet_names)).toEqual([]);
    expect(lintUpdateText(text.es, 'es', 'press_cluster', c.source.outlet_names)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 12 · The daily event ceiling.
 * ------------------------------------------------------------------ */
test.describe('dailyEventCount', () => {
  const store = {
    _meta: { schema: 1, generated_at: '2026-07-25T06:20:00Z' },
    a: {
      updates: [
        { recorded_at: '2026-07-25T06:20:00Z' },
        { recorded_at: '2026-07-25T23:59:59Z' },
        { recorded_at: '2026-07-24T23:00:00Z' },
      ],
    },
    b: { updates: [{ recorded_at: '2026-07-25T00:00:01Z' }] },
  };

  test('counts by recorded_at UTC day across every moment, ignoring _meta', () => {
    expect(dailyEventCount(store, '2026-07-25')).toBe(3);
    expect(dailyEventCount(store, '2026-07-24')).toBe(1);
    expect(dailyEventCount(store, '2026-07-23')).toBe(0);
  });

  test('an empty or missing store counts zero rather than throwing', () => {
    expect(dailyEventCount({}, '2026-07-25')).toBe(0);
    expect(dailyEventCount(undefined, '2026-07-25')).toBe(0);
  });
});
