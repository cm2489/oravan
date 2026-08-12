import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// Pure, I/O-free module (no CONGRESS_API_KEY/ANTHROPIC_API_KEY, no network)
// - see scripts/newsdesk-match.mjs's header comment for the full match
// design this pins.
import {
  anyDataChanged,
  assessFeeds,
  buildBillIndex,
  buildListIndex,
  chargeableDecode,
  countDistinctOutlets,
  decideFires,
  extractBillsThisWeekSlugs,
  extractFloorFeedSlugs,
  extractMostViewedSlugs,
  extractNicknameTokens,
  failedDecodeKey,
  FEED_DARK_ESCALATE_RUNS,
  findCitations,
  floorBucket,
  hashHeadline,
  looksLegislative,
  matchLocal,
  matchNickname,
  mondayOfWeekET,
  parseFeed,
  prunePendingOutlets,
  rollDailyDecodes,
  rollFeedDarkness,
  summarizePendingOutlets,
  tier0SeenKey,
  UNRESOLVED_OUTLET,
} from '../scripts/newsdesk-match.mjs';

test.describe('findCitations (t1 explicit bill-number citations)', () => {
  test('H.R. 1234 resolves to hr-1234-119', () => {
    expect(findCitations('House passes H.R. 1234 in bipartisan vote')).toEqual([
      { type: 'hr', number: '1234', slug: 'hr-1234-119' },
    ]);
  });

  test('HR1234 (no punctuation/space) resolves the same way', () => {
    expect(findCitations('Senate committee advances HR1234')).toEqual([
      { type: 'hr', number: '1234', slug: 'hr-1234-119' },
    ]);
  });

  test('S. 567 resolves to s-567-119', () => {
    expect(findCitations('Lawmakers debate S. 567 funding measure')).toEqual([
      { type: 's', number: '567', slug: 's-567-119' },
    ]);
  });

  test('H. Res. 12 is NOT tracked - must not match (simple House resolution, not hr/s/hjres/sjres)', () => {
    expect(findCitations('A new H. Res. 12 honors the local team')).toEqual([]);
  });

  test('"US 567" must not match S. - no word boundary inside "US"', () => {
    expect(findCitations('US 567 highway expansion project moves forward')).toEqual([]);
  });

  test('H.J.Res. 45 and the bare HJRES form both resolve to hjres-45-119', () => {
    expect(findCitations('H.J.Res. 45 disapproval resolution passes House')).toEqual([
      { type: 'hjres', number: '45', slug: 'hjres-45-119' },
    ]);
    expect(findCitations('HJRES 45 clears procedural hurdle')).toEqual([
      { type: 'hjres', number: '45', slug: 'hjres-45-119' },
    ]);
  });

  test('S.J.Res. 9 and the glued SJRES9 form both resolve to sjres-9-119', () => {
    expect(findCitations('S.J.Res. 9 heads to the floor')).toEqual([
      { type: 'sjres', number: '9', slug: 'sjres-9-119' },
    ]);
    expect(findCitations('SJRES9 gets a vote')).toEqual([
      { type: 'sjres', number: '9', slug: 'sjres-9-119' },
    ]);
  });

  test('multiple distinct citations in one headline are all found, deduped', () => {
    expect(findCitations('House passes H.R. 1234 while Senate weighs S. 45')).toEqual([
      { type: 'hr', number: '1234', slug: 'hr-1234-119' },
      { type: 's', number: '45', slug: 's-45-119' },
    ]);
  });

  test('case-insensitive', () => {
    expect(findCitations('hr1234 trending on social media')).toEqual([
      { type: 'hr', number: '1234', slug: 'hr-1234-119' },
    ]);
  });

  test('no citation-shaped text yields an empty array', () => {
    expect(findCitations('Local bakery wins county fair blue ribbon')).toEqual([]);
  });

  // An apostrophe is a non-word character, so \b used to fire between it and
  // the trailing "s" of a possessive, handing the bare S alternative that "s"
  // and the next number in the headline. A t1 citation short-circuits
  // corroboration (decideFires) and rides forceSlugs past the decode gate, so
  // these were force-refreshable arbitrary slugs, not cosmetic misses.
  test('an English possessive is not a Senate bill (straight apostrophe)', () => {
    expect(findCitations("Trump's 2026 budget request")).toEqual([]);
    expect(findCitations("Speaker's 4 must-pass bills")).toEqual([]);
  });

  test('an English possessive is not a Senate bill (curly apostrophe)', () => {
    expect(findCitations('Johnson’s 2026 spending plan')).toEqual([]);
    expect(findCitations('the Speaker’s 4 must-pass bills')).toEqual([]);
  });

  test('the real citations the possessive guard must NOT cost us', () => {
    expect(findCitations('S. 2026 passes committee')).toEqual([
      { type: 's', number: '2026', slug: 's-2026-119' },
    ]);
    // bare type token, no dot - matched before the guard, still matched after
    expect(findCitations('Senate passes S 2026')).toEqual([
      { type: 's', number: '2026', slug: 's-2026-119' },
    ]);
    expect(findCitations('HR 3633 heads to the floor')).toEqual([
      { type: 'hr', number: '3633', slug: 'hr-3633-119' },
    ]);
    // a LEFT curly quote is not a possessive - a quoted citation still cites
    expect(findCitations('‘S. 2026’ passes committee')).toEqual([
      { type: 's', number: '2026', slug: 's-2026-119' },
    ]);
  });

  test('a possessive earlier in the headline does not swallow a real citation later', () => {
    expect(findCitations("Trump's 2026 budget request hits H.R. 3633")).toEqual([
      { type: 'hr', number: '3633', slug: 'hr-3633-119' },
    ]);
    expect(findCitations('Johnson’s 2026 spending plan and S. 45 advance')).toEqual([
      { type: 's', number: '45', slug: 's-45-119' },
    ]);
  });
});

const BILLS = [
  { bill_type: 'hr', bill_number: 8463, congress_number: 119, title: 'Prevent Government Fraud Act of 2026', press_names: ['SAVE Act'] },
  { bill_type: 's', bill_number: 180, congress_number: 119, title: 'Secondary Exposure Act', press_names: null },
  { bill_type: 'hr', bill_number: 99, congress_number: 119, title: 'A generic bill about roads and bridges', press_names: null },
];

test.describe('matchLocal (t2 free token-overlap match)', () => {
  const index = buildBillIndex(BILLS);

  test('a headline naming the press_name + title words confidently matches one bill', () => {
    expect(matchLocal('Congress passes the SAVE Act to prevent government fraud', index)).toEqual({
      tier: 't2',
      slug: 'hr-8463-119',
    });
  });

  test('a headline with weak, tied overlap across two bills is ambiguous (t3-bound), not a guess', () => {
    const result = matchLocal('Secondary exposure concerns raised about bridges funding', index);
    expect(result?.tier).toBe('ambiguous');
    if (!result || !('candidates' in result)) throw new Error('unreachable');
    expect((result.candidates ?? []).map((c: { slug: string }) => c.slug).sort()).toEqual(['hr-99-119', 's-180-119']);
  });

  test('a headline with no meaningful overlap matches nothing', () => {
    expect(matchLocal('Local weather turns cooler this weekend', index)).toBeNull();
  });

  // REGRESSION (2026-07 logs): with a flat candidate floor of 2 shared
  // tokens, "the CHIPS Act" (1 shared token - "act" is a stopword) was
  // structurally unmatchable. Rare tokens (df<=3 across the index) now
  // count double, so a single-distinctive-token nickname reaches the
  // candidate list (ambiguous -> t3's job), while a lone COMMON token
  // still cannot.
  test('a single RARE shared token ("the CHIPS Act") is now a candidate, not unmatchable', () => {
    const chipsIndex = buildBillIndex([
      { bill_type: 'hr', bill_number: 4346, congress_number: 119, title: 'CHIPS and Science Act of 2026', press_names: ['CHIPS Act'] },
      ...BILLS,
    ]);
    const result = matchLocal('Senate weighs changes to the CHIPS Act', chipsIndex);
    expect(result).not.toBeNull();
    expect(result?.tier).toBe('ambiguous');
    if (!result || !('candidates' in result)) throw new Error('unreachable');
    expect((result.candidates ?? []).map((c: { slug: string }) => c.slug)).toContain('hr-4346-119');
  });

  test('a single COMMON shared token still yields no candidate (rare-weighting is not a floor drop)', () => {
    // "veterans" appears in 4 bills -> df 4 > RARE_TOKEN_MAX_DF(3) -> weight 1 < floor 2.
    const commonIndex = buildBillIndex([1, 2, 3, 4].map((n) => (
      { bill_type: 'hr', bill_number: n, congress_number: 119, title: `Veterans Homestead Improvement Act No${n}`, press_names: null }
    )));
    expect(matchLocal('Veterans parade draws a big crowd downtown', commonIndex)).toBeNull();
  });

  test('news_query is indexed alongside title + press_names (previously unused corpus field)', () => {
    const nqIndex = buildBillIndex([
      {
        bill_type: 'hjres', bill_number: 7, congress_number: 119,
        title: 'A joint resolution providing for congressional disapproval of a submitted rule',
        press_names: null,
        news_query: 'USCIS "employment authorization"',
      },
      ...BILLS,
    ]);
    const result = matchLocal('USCIS ends employment authorization extensions after new vote', nqIndex);
    expect(result).not.toBeNull();
    if (!result) throw new Error('unreachable');
    const slugs = result.tier === 't2' ? [result.slug] : (result.candidates ?? []).map((c: { slug: string }) => c.slug);
    expect(slugs).toContain('hjres-7-119');
  });
});

test.describe('looksLegislative (t3 batch gate)', () => {
  test('legislative-signal headlines pass', () => {
    expect(looksLegislative('Senate passes major infrastructure bill')).toBe(true);
    expect(looksLegislative('Committee advances markup on tax measure')).toBe(true);
  });

  test('non-legislative headlines do not, keeping the Haiku batch small', () => {
    expect(looksLegislative('Local bakery wins award')).toBe(false);
    expect(looksLegislative('')).toBe(false);
  });

  // Real failing cases from the 2026-07 run logs - the original regex had
  // no budget-process vocabulary, so the week's biggest bills never even
  // reached t3.
  test('REGRESSION: "Revised GOP crypto package" passes (was a logged miss)', () => {
    expect(looksLegislative('Revised GOP crypto package')).toBe(true);
  });

  test('REGRESSION: "Trump signs the megabill" passes (was a logged miss)', () => {
    expect(looksLegislative('Trump signs the megabill')).toBe(true);
  });

  test('stopgap / continuing resolution / budget blueprint / reconciliation all pass', () => {
    expect(looksLegislative('Leaders scramble for a stopgap before the shutdown deadline')).toBe(true);
    expect(looksLegislative('Continuing resolution talks stall')).toBe(true);
    expect(looksLegislative('GOP unveils budget blueprint for 2027')).toBe(true);
    expect(looksLegislative('Reconciliation math gets harder for leadership')).toBe(true);
  });
});

test.describe('decideFires (the >=2-outlet corroboration rule)', () => {
  test('a citation match fires off a SINGLE outlet - no corroboration required', () => {
    const { fired, reason } = decideFires(new Set(['hr-1-119']), new Map());
    expect(fired).toEqual(new Set(['hr-1-119']));
    expect(reason.get('hr-1-119')).toBe('citation');
  });

  test('a t2/t3 match from exactly ONE outlet does NOT fire', () => {
    const outlets = new Map([['s-2-119', new Set(['cbsnews.com'])]]);
    const { fired } = decideFires(new Set(), outlets);
    expect(fired.size).toBe(0);
  });

  test('a t2/t3 match from TWO distinct outlets fires as corroborated', () => {
    const outlets = new Map([['s-3-119', new Set(['cbsnews.com', 'foxnews.com'])]]);
    const { fired, reason } = decideFires(new Set(), outlets);
    expect(fired).toEqual(new Set(['s-3-119']));
    expect(reason.get('s-3-119')).toBe('corroborated');
  });

  test('the SAME outlet appearing twice does not count as two outlets (Set dedupes)', () => {
    const outlets = new Map([['s-4-119', new Set(['cbsnews.com'])]]); // caller already deduped by Set
    const { fired } = decideFires(new Set(), outlets);
    expect(fired.size).toBe(0);
  });

  test('citation and corroboration combine without double-counting or colliding', () => {
    const citations = new Set(['hr-1-119']);
    const outlets = new Map([
      ['hr-1-119', new Set(['cbsnews.com'])], // also has a lone t2 hit - citation reason wins
      ['s-3-119', new Set(['thehill.com', 'npr.org'])],
    ]);
    const { fired, reason } = decideFires(citations, outlets);
    expect(fired).toEqual(new Set(['hr-1-119', 's-3-119']));
    expect(reason.get('hr-1-119')).toBe('citation');
    expect(reason.get('s-3-119')).toBe('corroborated');
  });

  test('a tier-0 government slug fires with ZERO press signal (guardrail bypass by design)', () => {
    const tier0 = new Map([['hr-8800-119', 'house-bills-this-week']]);
    const { fired, reason } = decideFires(new Set(), new Map(), tier0);
    expect(fired).toEqual(new Set(['hr-8800-119']));
    expect(reason.get('hr-8800-119')).toBe('tier0:house-bills-this-week');
  });

  test('tier-0 reason takes precedence when the same slug also has a press citation', () => {
    const tier0 = new Map([['s-4784-119', 'senate-floor-today']]);
    const { fired, reason } = decideFires(new Set(['s-4784-119']), new Map(), tier0);
    expect(fired).toEqual(new Set(['s-4784-119']));
    expect(reason.get('s-4784-119')).toBe('tier0:senate-floor-today');
  });

  test('tier-0 does NOT loosen the press guardrail for other slugs', () => {
    const tier0 = new Map([['hr-8800-119', 'house-floor-today']]);
    const outlets = new Map([['s-2-119', new Set(['cbsnews.com'])]]); // still only 1 outlet
    const { fired } = decideFires(new Set(), outlets, tier0);
    expect(fired).toEqual(new Set(['hr-8800-119']));
  });
});

/*
 * THE UNRESOLVED-OUTLET HOLE (2026-08-09).
 *
 * The corroboration rule counts DISTINCT outlets, and an article whose outlet
 * could not be resolved to a domain was filed under the synthetic name
 * 'unknown' — which the Set then counted as a whole second newsroom. Exactly
 * one feed in the basket can produce that: Google News, which carries no
 * domain of its own and attributes per article via a <source url="…"> tag. So
 * one outlet's story arriving twice — once from that outlet's own feed, once
 * as the same story with an unparseable Google News source tag — presented as
 * {'cbsnews.com', 'unknown'} and CLEARED a guardrail whose entire purpose is
 * to require two independent newsrooms before a soft match can act. That is
 * the single-outlet prioritization channel decideFires's header comment says
 * must never exist.
 */
test.describe('unresolved outlets never corroborate (the self-corroboration hole)', () => {
  test('the sentinel is not counted as an outlet', () => {
    expect(countDistinctOutlets(new Set(['cbsnews.com', UNRESOLVED_OUTLET]))).toBe(1);
    expect(countDistinctOutlets(new Set([UNRESOLVED_OUTLET]))).toBe(0);
    expect(countDistinctOutlets(new Set(['cbsnews.com', 'foxnews.com']))).toBe(2);
  });

  test('empty, null and blank entries are not outlets either', () => {
    expect(countDistinctOutlets(null)).toBe(0);
    expect(countDistinctOutlets(new Set())).toBe(0);
    expect(countDistinctOutlets(new Set([null, '', '   ']))).toBe(0);
  });

  test('casing/whitespace variants of one domain are still ONE outlet', () => {
    expect(countDistinctOutlets(new Set(['CBSNews.com', 'cbsnews.com', ' cbsnews.com ']))).toBe(1);
    expect(countDistinctOutlets(new Set(['UNKNOWN', 'unknown']))).toBe(0);
  });

  test('the same story via its own feed + an unattributable Google News item does NOT fire', () => {
    const outlets = new Map([['hr-9001-119', new Set(['cbsnews.com', UNRESOLVED_OUTLET])]]);
    const { fired } = decideFires(new Set(), outlets);
    expect(fired.size).toBe(0);
  });

  test('two REAL outlets still fire, unresolved item present or not', () => {
    const clean = new Map([['hr-9002-119', new Set(['cbsnews.com', 'foxnews.com'])]]);
    expect(decideFires(new Set(), clean).fired).toEqual(new Set(['hr-9002-119']));

    const withUnknown = new Map([
      ['hr-9003-119', new Set(['cbsnews.com', 'foxnews.com', UNRESOLVED_OUTLET])],
    ]);
    const { fired, reason } = decideFires(new Set(), withUnknown);
    expect(fired).toEqual(new Set(['hr-9003-119']));
    expect(reason.get('hr-9003-119')).toBe('corroborated');
  });

  test('an unresolved-only hold still reads as a hold in the log, not as a fired pair', () => {
    // Counting at read time also disarms the 'unknown' entries already
    // persisted in the live cache by earlier runs.
    const now = Date.parse('2026-08-09T12:00:00Z');
    const summary = summarizePendingOutlets({
      'hr-9004-119': {
        outlets: [UNRESOLVED_OUTLET, 'npr.org'],
        updated: new Date(now - 2 * 86_400_000).toISOString(),
      },
    }, now);
    expect(summary).toContain('hr-9004-119<-npr.org (2d)');
    expect(summary).not.toContain(UNRESOLVED_OUTLET);
  });
});

// ---- tier-0 government feed parsers (samples mirror the live shapes
// ---- fetched read-only 2026-07-23) --------------------------------------

test.describe('extractFloorFeedSlugs (Congress.gov floor-today RSS: title IS the bill number)', () => {
  const HOUSE_FLOOR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>House Floor Today</title>
<item><title>H.R.8884</title><description><![CDATA[Removing Barriers to Work for Disabled Americans Act (07/23/2026)]]></description><link>https://www.congress.gov/bill/119th-congress/house-bill/8884</link></item>
<item><title>H.Con.Res.89</title><description><![CDATA[War powers resolution]]></description><link>https://www.congress.gov/bill/119th-congress/house-concurrent-resolution/89</link></item>
</channel></rss>`;

  test('extracts tracked bill numbers from item titles', () => {
    // hconres tracked as of 2026-07-23 (War Powers fights ride on
    // concurrent resolutions - the H.Con.Res.38 invisibility bug).
    expect(extractFloorFeedSlugs(HOUSE_FLOOR_XML)).toEqual(['hr-8884-119', 'hconres-89-119']);
  });

  test('H.Con.Res resolves as hconres, never mis-parsed as H.R.', () => {
    expect(extractFloorFeedSlugs(HOUSE_FLOOR_XML)).not.toContain('hr-89-119');
  });

  test('senate shape works the same way', () => {
    const xml = '<rss><channel><item><title>S.4784</title><link>https://www.congress.gov/bill/119th-congress/senate-bill/4784</link></item></channel></rss>';
    expect(extractFloorFeedSlugs(xml)).toEqual(['s-4784-119']);
  });
});

test.describe('extractMostViewedSlugs (weekly single item, <ol> description with [Nth] congress tags)', () => {
  // Trimmed from the live 2026-07-19 item: one 118th-congress entry mixed
  // in with 119th entries - exactly the case the congress filter exists for.
  const MOST_VIEWED_XML = `<rss><channel><item><title>Most-Viewed Bills - Week of July 19, 2026</title>
<description><![CDATA[<ol><li><a href='https://www.congress.gov/bill/118th-congress/house-bill/4818'>H.R.4818</a> [118th] - Treat and Reduce Obesity Act of 2023</li> <li><a href='https://www.congress.gov/bill/119th-congress/house-bill/7296'>H.R.7296</a> [119th] - SAVE America Act</li> <li><a href='https://www.congress.gov/bill/119th-congress/senate-bill/2296'>S.2296</a> [119th] - National Defense Authorization Act for Fiscal Year 2026</li> </ol>]]></description>
<link>https://www.congress.gov/most-viewed-bills</link></item></channel></rss>`;

  test('accepts ONLY 119th-congress entries', () => {
    expect(extractMostViewedSlugs(MOST_VIEWED_XML).sort()).toEqual(['hr-7296-119', 's-2296-119']);
  });

  test('the 118th-congress entry is excluded, not remapped to the 119th', () => {
    expect(extractMostViewedSlugs(MOST_VIEWED_XML)).not.toContain('hr-4818-119');
  });

  test('empty/garbage input yields no slugs', () => {
    expect(extractMostViewedSlugs('')).toEqual([]);
    expect(extractMostViewedSlugs('<rss><channel></channel></rss>')).toEqual([]);
  });
});

test.describe('extractBillsThisWeekSlugs (docs.house.gov floorschedule look-ahead)', () => {
  // Trimmed from the live 20260720 file: legis-num values carry trailing
  // spaces and spaced type forms; floor-text prose cites OTHER bills that
  // must not leak in.
  const FLOORSCHEDULE_XML = `<floorschedule congress-num="119" week-date="2026-07-20">
<floor-item><legis-num>H.R. 2715 </legis-num><floor-text>Destruction of Hazardous Imports Act, as amended </floor-text></floor-item>
<floor-item><legis-num>H. Con. Res. 113</legis-num><floor-text>Establishing the congressional budget</floor-text></floor-item>
<floor-item><legis-num>H.R. 9770</legis-num><floor-text>Continuing Appropriations Act, 2027</floor-text></floor-item>
<floor-item><legis-num>H. Res. 1438</legis-num><floor-text>Providing for consideration of the bill (H.R. 8800) and the bill (H.R. 7008)</floor-text></floor-item>
</floorschedule>`;

  test('extracts tracked legis-num bills (the look-ahead: scheduled before the vote)', () => {
    // hconres tracked as of 2026-07-23; H. Res. (simple resolution) stays out.
    expect(extractBillsThisWeekSlugs(FLOORSCHEDULE_XML).sort()).toEqual([
      'hconres-113-119',
      'hr-2715-119',
      'hr-9770-119',
    ]);
  });

  test('H. Con. Res. resolves as hconres; untracked H. Res. legis-nums stay excluded', () => {
    const slugs = extractBillsThisWeekSlugs(FLOORSCHEDULE_XML);
    expect(slugs).not.toContain('hr-113-119');
    expect(slugs).not.toContain('hr-1438-119');
    expect(slugs).not.toContain('hres-1438-119');
  });

  test('bills cited only in floor-text prose (H.R. 8800 in the rule item) do NOT leak in', () => {
    expect(extractBillsThisWeekSlugs(FLOORSCHEDULE_XML)).not.toContain('hr-8800-119');
  });
});

test.describe('mondayOfWeekET (docs.house.gov URL week key)', () => {
  test('mid-week UTC instant maps to that week\'s ET Monday', () => {
    // Thu 2026-07-23 12:00Z = Thu morning ET
    expect(mondayOfWeekET(new Date('2026-07-23T12:00:00Z'))).toBe('20260720');
  });

  test('Monday maps to itself; Sunday maps BACK to its week\'s Monday (not forward)', () => {
    expect(mondayOfWeekET(new Date('2026-07-20T12:00:00Z'))).toBe('20260720');
    expect(mondayOfWeekET(new Date('2026-07-26T12:00:00Z'))).toBe('20260720'); // Sunday ET
  });

  test('early-UTC Monday is still Sunday in ET and belongs to the PREVIOUS week', () => {
    // 2026-07-20T01:00Z = Sun 2026-07-19 21:00 ET
    expect(mondayOfWeekET(new Date('2026-07-20T01:00:00Z'))).toBe('20260713');
  });
});

test.describe('prunePendingOutlets + summarizePendingOutlets (guardrail-hold hygiene)', () => {
  const now = Date.parse('2026-07-23T12:00:00Z');
  const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();

  test('entries older than 7 days expire; fresh ones are kept', () => {
    const { kept, expired } = prunePendingOutlets({
      'hr-1-119': { outlets: ['thehill.com'], updated: iso(8) },
      's-2-119': { outlets: ['npr.org'], updated: iso(2) },
    }, now);
    expect(Object.keys(kept)).toEqual(['s-2-119']);
    expect(expired).toEqual(['hr-1-119']);
  });

  test('an entry with a missing/corrupt timestamp expires (fail-closed)', () => {
    const { kept, expired } = prunePendingOutlets({ 'hr-3-119': { outlets: ['foxnews.com'] } }, now);
    expect(Object.keys(kept)).toEqual([]);
    expect(expired).toEqual(['hr-3-119']);
  });

  test('summary lists only single-outlet holds, with slug/outlet/age - never headline text', () => {
    const summary = summarizePendingOutlets({
      'hr-1-119': { outlets: ['thehill.com'], updated: iso(3) },
      's-2-119': { outlets: ['npr.org', 'cbsnews.com'], updated: iso(1) }, // 2 outlets: fires, not a hold
    }, now);
    expect(summary).toContain('hr-1-119<-thehill.com (3d)');
    expect(summary).not.toContain('s-2-119');
  });

  test('no holds yields the explicit "none" line (visible even when quiet)', () => {
    expect(summarizePendingOutlets({}, now)).toBe('pending single-outlet holds: none');
  });
});

// ---- nickname bridge (non-corpus bills covered by name only) ------------

test.describe('extractNicknameTokens', () => {
  test('capitalized act names yield their distinctive tokens ("SAVE America Act" - the logged miss)', () => {
    const tokens = extractNicknameTokens('Democrats rally behind the SAVE America Act ahead of the vote');
    expect(tokens).toContain('save');
    expect(tokens).toContain('america');
  });

  test('quoted names are picked up', () => {
    expect(extractNicknameTokens('Senate leaders tout the "Digital Asset Market Clarity" plan')).toEqual(
      expect.arrayContaining(['digital', 'asset', 'market', 'clarity'])
    );
  });

  test('ALL-CAPS acronyms are picked up; short scraps (GOP) and stopwords drop out', () => {
    const tokens = extractNicknameTokens('GOP leaders say NDAA talks stall');
    expect(tokens).toContain('ndaa');
    expect(tokens).not.toContain('gop');
  });

  test('a headline with no distinctive name yields no tokens (bridge stays silent)', () => {
    expect(extractNicknameTokens('lawmakers spar over spending levels')).toEqual([]);
  });
});

test.describe('matchNickname (against a Congress.gov recently-updated list index)', () => {
  const LIST = [
    { congress: 119, type: 'HR', number: 7296, title: 'SAVE America Act' },
    { congress: 119, type: 'HR', number: 8800, title: 'National Defense Authorization Act for Fiscal Year 2027' },
    { congress: 119, type: 'S', number: 2296, title: 'National Defense Authorization Act for Fiscal Year 2026' },
    { congress: 118, type: 'HR', number: 4818, title: 'Treat and Reduce Obesity Act of 2023' }, // wrong congress - excluded at index build
    { congress: 119, type: 'HRES', number: 1438, title: 'Providing for consideration of the SAVE America Act' }, // untracked type - excluded
  ];
  const listIndex = buildListIndex(LIST);

  test('buildListIndex keeps only tracked types in the 119th', () => {
    expect(listIndex.map((e: { slug: string }) => e.slug).sort()).toEqual(['hr-7296-119', 'hr-8800-119', 's-2296-119']);
  });

  test('REGRESSION: "SAVE America Act" (non-corpus, nickname-only coverage) resolves to its bill', () => {
    const tokens = extractNicknameTokens('House passes the SAVE America Act in a late-night vote');
    expect(matchNickname(tokens, listIndex)).toEqual({ slug: 'hr-7296-119', title: 'SAVE America Act' });
  });

  test('a tie between two equally-good candidates is ambiguity - returns null, never guesses', () => {
    // "defense" + "authorization" hit BOTH NDAA bills equally.
    const tokens = ['defense', 'authorization'];
    expect(matchNickname(tokens, listIndex)).toBeNull();
  });

  test('tokens matching nothing (an acronym absent from formal titles, e.g. NDAA) return null', () => {
    expect(matchNickname(['ndaa'], listIndex)).toBeNull();
  });

  test('empty token list returns null without scanning', () => {
    expect(matchNickname([], listIndex)).toBeNull();
  });
});

test.describe('anyDataChanged (the no-change-no-commit guard)', () => {
  test('no fired bills at all -> no change', () => {
    expect(anyDataChanged([])).toBe(false);
  });

  test('every outcome deferred/failed -> no change (nothing to commit)', () => {
    expect(anyDataChanged(['budget', 'failed', 'budget'])).toBe(false);
  });

  test('a free refresh alone counts as a change', () => {
    expect(anyDataChanged(['refreshed'])).toBe(true);
  });

  test('a decode alone counts as a change', () => {
    expect(anyDataChanged(['budget', 'added', 'failed'])).toBe(true);
  });

  test('a RE-decode counts too — it rewrites an existing record and its ES twin', () => {
    // The re-decode trigger (2026-08-12) is the only path that mutates a bill
    // nothing else touched this run; if this outcome did not count, a run
    // whose only work was re-reading a swapped vehicle would write nothing
    // and the corrected decode would be lost with the process.
    expect(anyDataChanged(['redecoded'])).toBe(true);
    expect(anyDataChanged(['skipped_no_text', 'redecoded'])).toBe(true);
  });
});

test.describe('hashHeadline (seen-headlines dedupe key)', () => {
  test('normalizes whitespace and case so near-identical entries collide on purpose', () => {
    expect(hashHeadline('Some Title', 'cbsnews.com')).toBe(hashHeadline('some   title  ', 'CBSNEWS.com'));
  });

  test('different outlets for the same title hash differently (per-outlet dedupe)', () => {
    expect(hashHeadline('Some Title', 'cbsnews.com')).not.toBe(hashHeadline('Some Title', 'foxnews.com'));
  });
});

/*
 * Tier-0 floor windows (2026-08-08). The throttle used to be one refresh
 * per bill per UTC day, which capped freshness rather than cost:
 * Congress.gov publishes day D's floor actions on D+1 between 13:35 and
 * 14:00 UTC (6/6 consecutive legislative days by senate.gov Last-Modified;
 * corroborated by this repo's corpus - absent at 08:30-10:10 UTC commits,
 * present at 12:15-17:42), so an early-morning run spent the day's only
 * slot on the pre-publication record. See floorBucket's comment in
 * scripts/newsdesk-match.mjs.
 */
test.describe('floorBucket (which publication window a run is spending)', () => {
  const at = (hour: number, minute = 0) =>
    floorBucket(new Date(Date.UTC(2026, 7, 12, hour, minute)));

  test('pre: 00:00-13:59 UTC - before the observed publication band', () => {
    expect(at(0)).toBe('pre');
    expect(at(12, 15)).toBe('pre'); // earliest observed API flip
    expect(at(13, 59)).toBe('pre');
  });

  test('record: 14:00-18:59 UTC - opens after the latest observed publication (13:55) plus margin', () => {
    expect(at(14)).toBe('record');
    expect(at(18, 59)).toBe('record');
  });

  test('session: 19:00-23:59 UTC - evening updates during late sessions', () => {
    expect(at(19)).toBe('session');
    expect(at(23, 59)).toBe('session');
  });

  test('defaults to now when called with no argument, and only ever returns one of the three windows', () => {
    expect(['pre', 'record', 'session']).toContain(floorBucket());
  });
});

test.describe('tier0SeenKey (the tier-0 refresh throttle)', () => {
  const DAY = '2026-08-12';

  test('same slug, same UTC day, DIFFERENT window -> a different key, so the refresh is allowed again', () => {
    const pre = tier0SeenKey('hr-8884-119', DAY, 'pre');
    const record = tier0SeenKey('hr-8884-119', DAY, 'record');
    const session = tier0SeenKey('hr-8884-119', DAY, 'session');
    expect(new Set([pre, record, session]).size).toBe(3);
  });

  test('same slug, same UTC day, SAME window -> the same key, so a second run in that window is throttled', () => {
    expect(tier0SeenKey('hr-8884-119', DAY, 'record')).toBe(tier0SeenKey('hr-8884-119', DAY, 'record'));
  });

  test('same slug, same window, DIFFERENT UTC day -> a different key (the day still rolls)', () => {
    expect(tier0SeenKey('hr-8884-119', DAY, 'record')).not.toBe(tier0SeenKey('hr-8884-119', '2026-08-13', 'record'));
  });

  test('different slugs never collide inside one window', () => {
    expect(tier0SeenKey('hr-8884-119', DAY, 'record')).not.toBe(tier0SeenKey('s-8884-119', DAY, 'record'));
  });

  test('a tier-0 key never collides with a press headline key for the same text', () => {
    expect(tier0SeenKey('hr-8884-119', DAY, 'record')).not.toBe(hashHeadline('hr-8884-119', DAY));
  });

  test('the window defaults to the current clock when omitted', () => {
    expect(tier0SeenKey('hr-8884-119', DAY)).toBe(tier0SeenKey('hr-8884-119', DAY, floorBucket()));
  });
});

/*
 * COST INVARIANCE. Tripling the seen-key's granularity buys more FREE
 * congress.gov refreshes. It must not buy one extra Anthropic decode: the
 * decode budgets (TIER0_DECODE_CAP per run, TIER0_DAILY_DECODE_CAP per UTC
 * day, plus the press pair) are accounted independently of the seen-key.
 * Two halves, same shape as tests/rollover-tripwire.unit.spec.ts: the
 * logic, then the wiring that decides whether the logic ever runs.
 */
test.describe('cost invariance: the daily decode budget is keyed by UTC day, never by floor window', () => {
  test('rollDailyDecodes takes no window argument at all (arity 2: the counters, the day)', () => {
    expect(rollDailyDecodes.length).toBe(2);
  });

  test('counts survive every window transition inside one UTC day', () => {
    let daily = { date: '2026-08-12', count: 4, tier0Count: 11 };
    // pre -> record -> session: three separate refresh slots, one budget.
    for (let i = 0; i < 3; i++) daily = rollDailyDecodes(daily, '2026-08-12');
    expect(daily).toEqual({ date: '2026-08-12', count: 4, tier0Count: 11 });
  });

  test('counts reset only when the UTC date itself changes', () => {
    expect(rollDailyDecodes({ date: '2026-08-12', count: 4, tier0Count: 11 }, '2026-08-13'))
      .toEqual({ date: '2026-08-13', count: 0, tier0Count: 0 });
  });

  test('a missing/cold cache starts the day at zero', () => {
    expect(rollDailyDecodes(null, '2026-08-12')).toEqual({ date: '2026-08-12', count: 0, tier0Count: 0 });
  });

  test('a pre-tier-0 cache keeps its press count and gains a zeroed tier-0 count (no free day)', () => {
    expect(rollDailyDecodes({ date: '2026-08-12', count: 7 }, '2026-08-12'))
      .toEqual({ date: '2026-08-12', count: 7, tier0Count: 0 });
  });

  test('never mutates the persisted object it was handed', () => {
    const persisted = { date: '2026-08-12', count: 4, tier0Count: 11 };
    rollDailyDecodes(persisted, '2026-08-13');
    expect(persisted).toEqual({ date: '2026-08-12', count: 4, tier0Count: 11 });
  });
});

test.describe('cost invariance: the wiring in scripts/newsdesk.mjs', () => {
  const src = readFileSync(join(process.cwd(), 'scripts/newsdesk.mjs'), 'utf8');

  test('the rollover is called with the UTC day and nothing else', () => {
    expect(src).toMatch(/cache\.dailyDecodes\s*=\s*rollDailyDecodes\(cache\.dailyDecodes,\s*todayUTC\)/);
    // No second call site could sneak a window in.
    expect(src.match(/rollDailyDecodes\(/g)).toHaveLength(1);
  });

  test('the decode gate reads the per-run counters and the daily counters - never the window, never the seen-key', () => {
    const gate = src.slice(src.indexOf('const allowDecode'), src.indexOf('const result = await syncOneBill'));
    expect(gate).toContain('TIER0_DAILY_DECODE_CAP');
    expect(gate).toContain('NEWSDESK_DAILY_DECODE_CAP');
    expect(gate).not.toMatch(/floorWindow|floorBucket|tier0Key|tier0SeenKey|cache\.seen/);
  });

  test('the counters are incremented once per CHARGED decode, and only by 1', () => {
    expect(src).toMatch(/tier0DecodesThisRun\+\+;\s*cache\.dailyDecodes\.tier0Count\+\+;/);
    expect(src).toMatch(/pressDecodesThisRun\+\+;\s*cache\.dailyDecodes\.count\+\+;/);
    // Guarded by chargeableDecode, NOT by outcome === 'added' (2026-08-09).
    // Charging on success alone let a decode that reached the model and then
    // threw cost the caps nothing while costing real money - see the
    // chargeableDecode suite below.
    expect(src).toMatch(/if \(chargeableDecode\(result\)\) \{/);
    expect(src).not.toMatch(/if \(result\.outcome === 'added'\) \{\s*if \(isTier0\)/);
  });

  test('a paid failure is held for the rest of the UTC day, and only a paid one', () => {
    // The hold is written inside the charged branch, so a failure BEFORE the
    // first model call (a Congress.gov timeout - free) never blocks the retry.
    const charged = src.slice(src.indexOf('if (chargeableDecode(result)) {'), src.indexOf('if (result.outcome === \'refreshed\''));
    expect(charged).toMatch(/cache\.seen\.add\(failedDecodeKey\(slug, todayUTC\)\)/);
    expect(charged).toMatch(/result\.outcome !== 'added'/);
    // Keyed by UTC day only - never by floor window. The slug argument is
    // matched loosely because there are now two call sites that hold the same
    // key: the fire loop (`slug`) and the re-decode trigger (`cand.slug`,
    // 2026-08-12). What the invariant is about is the SECOND argument - a
    // window in there would grant three paid retries a day instead of one.
    expect(src.match(/failedDecodeKey\([^)]*\)/g)?.every((c) => /failedDecodeKey\([\w.]+, todayUTC\)/.test(c))).toBe(true);
  });

  test('the failure hold can only SUBTRACT decodes - it is ANDed into allowDecode, never a new budget', () => {
    const gate = src.slice(src.indexOf('const allowDecode'), src.indexOf('const result = await syncOneBill'));
    expect(gate).toContain('!decodeFailedToday');
    // Still no window, no seen-key, no cache read inside the gate itself:
    // decodeFailedToday is resolved above it, so the cost invariant pinned by
    // the previous test holds unchanged.
    expect(gate).not.toMatch(/floorWindow|floorBucket|tier0Key|tier0SeenKey|cache\.seen/);
  });

  test('the per-run and per-day caps keep their values (the window split raised no ceiling)', () => {
    expect(src).toMatch(/TIER0_DECODE_CAP = Number\(process\.env\.NEWSDESK_TIER0_DECODE_CAP \?\? 6\)/);
    expect(src).toMatch(/TIER0_DAILY_DECODE_CAP = Number\(process\.env\.NEWSDESK_TIER0_DAILY_DECODE_CAP \?\? 20\)/);
    expect(src).toMatch(/NEWSDESK_DECODE_CAP = Number\(process\.env\.NEWSDESK_DECODE_CAP \?\? 3\)/);
    expect(src).toMatch(/NEWSDESK_DAILY_DECODE_CAP = Number\(process\.env\.NEWSDESK_DAILY_DECODE_CAP \?\? 10\)/);
  });

  test('the run logs which window it is spending', () => {
    expect(src).toMatch(/newsdesk tier-0 \[\$\{floorWindow\} window/);
  });

  test('the re-decode trigger spends the EXISTING tier-0 budget and never a new one', () => {
    // The trigger (2026-08-12) can pay for a Sonnet decode of a bill already
    // in the corpus. The whole cost argument in this script's header rests on
    // two code-enforced ceilings, so the new spender must sit inside them
    // rather than beside them: same per-run cap, same per-day counter, same
    // charge-on-attempt rule, same one-failure-per-day hold.
    const block = src.slice(src.indexOf('const candidates = redecodeCandidates('));
    expect(block).toContain('TIER0_DECODE_CAP');
    expect(block).toContain('TIER0_DAILY_DECODE_CAP');
    expect(block).toMatch(/if \(chargeableDecode\(result\)\) \{\s*tier0DecodesThisRun\+\+;\s*cache\.dailyDecodes\.tier0Count\+\+;/);
    expect(block).toContain('failedDecodeKey(cand.slug, todayUTC)');
    // No second budget may be introduced anywhere in the file.
    expect(src).not.toMatch(/REDECODE_(DAILY_)?DECODE_CAP/);
    // The free refresh it does to read the served title must stay free.
    expect(block).toMatch(/allowDecode: false/);
  });

  test('the re-decode trigger treats a missing floor-signals file as absent, never as a failure', () => {
    const loader = src.slice(src.indexOf('const floorSignals ='), src.indexOf('const candidates ='));
    expect(loader).toMatch(/catch \{[\s\S]*return null;/);
  });
});

/*
 * PAYING FOR FAILURE (2026-08-09).
 *
 * The caps used to be charged on outcome === 'added', i.e. on SUCCESS. A
 * decode that reached the model and then threw - bill-decode.mjs's shape
 * check rejecting a reply with a missing tag, deterministic for a given
 * verbose bill - had already spent a Sonnet call, charged the caps nothing,
 * and left its slug unmarked, so the same bill re-fired on the next hourly
 * run and every one after it: 24 paid attempts a day at a failure that could
 * not succeed, straight through a ceiling the header calls code-enforced.
 * The invoice prices attempts, so the cap has to price attempts.
 */
test.describe('chargeableDecode (the caps price the attempt, not the win)', () => {
  test('a landed decode is charged', () => {
    expect(chargeableDecode({ outcome: 'added', slug: 'hr-1-119', decodeAttempted: true })).toBe(true);
  });

  test('a decode that reached the model and THEN threw is charged - this is the whole fix', () => {
    expect(chargeableDecode({ outcome: 'failed', slug: 'hr-2-119', isNew: true, decodeAttempted: true })).toBe(true);
  });

  test('a failure BEFORE the first model call is free and stays free (a transient upstream blip must still retry)', () => {
    expect(chargeableDecode({ outcome: 'failed', slug: 'hr-3-119', isNew: true, decodeAttempted: false })).toBe(false);
  });

  test('the free outcomes are never charged: refreshed, gated, budget', () => {
    for (const outcome of ['refreshed', 'gated', 'budget']) {
      expect(chargeableDecode({ outcome, slug: 'hr-4-119', decodeAttempted: false }), outcome).toBe(false);
    }
  });

  test('a result from a caller that never set the flag is not charged (no phantom spend)', () => {
    expect(chargeableDecode({ outcome: 'refreshed', slug: 'hr-5-119' })).toBe(false);
    expect(chargeableDecode(undefined)).toBe(false);
    expect(chargeableDecode(null)).toBe(false);
  });

  test('only a real boolean true charges - a truthy accident does not', () => {
    expect(chargeableDecode({ outcome: 'added', decodeAttempted: 1 as unknown as boolean })).toBe(false);
  });
});

test.describe('failedDecodeKey (one paid failure per slug per UTC day, not per hour)', () => {
  test('the same slug on the same day is the same key - the 2nd..24th run of the day is suppressed', () => {
    expect(failedDecodeKey('hr-8283-119', '2026-08-09')).toBe(failedDecodeKey('hr-8283-119', '2026-08-09'));
  });

  test('the day rolls, so tomorrow gets exactly one fresh attempt', () => {
    expect(failedDecodeKey('hr-8283-119', '2026-08-09')).not.toBe(failedDecodeKey('hr-8283-119', '2026-08-10'));
  });

  test('different slugs never collide', () => {
    expect(failedDecodeKey('hr-8283-119', '2026-08-09')).not.toBe(failedDecodeKey('s-8283-119', '2026-08-09'));
  });

  test('never collides with a tier-0 refresh slot or a headline key for the same slug/day', () => {
    const keys = new Set([
      failedDecodeKey('hr-8283-119', '2026-08-09'),
      tier0SeenKey('hr-8283-119', '2026-08-09', 'record'),
      tier0SeenKey('hr-8283-119', '2026-08-09', 'pre'),
      hashHeadline('hr-8283-119', '2026-08-09'),
    ]);
    expect(keys.size).toBe(4);
  });
});

/*
 * CALLING DARKNESS QUIET (2026-08-09).
 *
 * Promise.allSettled swallowed every feed failure into a console.error, and a
 * feed that answers 200 with an empty/stub body never even reaches the
 * rejected branch. Both shapes exit 0 looking exactly like a quiet news hour,
 * so a total ingest outage could sit behind green checks indefinitely. These
 * pin the judgment; the escalation streak is what turns a blip into a build.
 */
test.describe('assessFeeds (the intake tripwire)', () => {
  const run = (tier0Failed: number, pressSilent: number) =>
    assessFeeds({ tier0Total: 4, tier0Failed, pressTotal: 9, pressSilent });

  test('a healthy run warns about nothing', () => {
    expect(run(0, 0)).toEqual({ tier0Dark: false, pressDark: false, pressDegraded: false, dark: false });
  });

  test('one or two dead feeds are normal weather, not a warning', () => {
    // AP's RSS 404s and the Washington Post politics feed serves a stub body;
    // both were found dead during the 2026-07-16 basket verification. An
    // hourly job that shouts at that teaches its owner to ignore it.
    expect(run(1, 2).tier0Dark).toBe(false);
    expect(run(1, 2).pressDegraded).toBe(false);
    expect(run(3, 4).pressDegraded).toBe(false); // 3 of 4 tier-0 is still not all
    expect(run(3, 4).dark).toBe(false);
  });

  test('ALL tier-0 feeds failing is called out on its own - the highest-precision signal is gone', () => {
    expect(run(4, 0).tier0Dark).toBe(true);
    expect(run(4, 0).dark).toBe(false); // press still answering: degraded, not dark
  });

  test('half the press basket silent is called out on its own', () => {
    expect(run(0, 5).pressDegraded).toBe(true);
    expect(run(0, 4).pressDegraded).toBe(false);
    expect(run(0, 5).dark).toBe(false); // tier-0 still answering
  });

  test('FULLY dark means every tier-0 feed failed AND every press feed was silent', () => {
    const r = run(4, 9);
    expect(r).toEqual({ tier0Dark: true, pressDark: true, pressDegraded: true, dark: true });
  });

  test('a press feed that returns 200 with zero items counts as silent - the outage with no error message', () => {
    // The caller counts threw-OR-empty into pressSilent; this pins that a
    // basket of nothing-but-empty-bodies is dark, not quiet.
    expect(assessFeeds({ tier0Total: 4, tier0Failed: 4, pressTotal: 9, pressSilent: 9 }).dark).toBe(true);
  });

  test('an empty source list can never read as dark (no feeds configured is not an outage)', () => {
    expect(assessFeeds({ tier0Total: 0, tier0Failed: 0, pressTotal: 0, pressSilent: 0 }).dark).toBe(false);
  });
});

test.describe('rollFeedDarkness (a blip warns; a blackout reds the build)', () => {
  test('the streak climbs one run at a time and does not escalate early', () => {
    let state = rollFeedDarkness(null, true);
    expect(state).toEqual({ consecutiveDark: 1, escalate: false });
    for (let i = 2; i < FEED_DARK_ESCALATE_RUNS; i++) {
      state = rollFeedDarkness(state, true);
      expect(state.consecutiveDark).toBe(i);
      expect(state.escalate).toBe(false);
    }
  });

  test(`escalates at exactly ${FEED_DARK_ESCALATE_RUNS} consecutive dark runs - six hourly runs is six hours dark`, () => {
    const state = rollFeedDarkness({ consecutiveDark: FEED_DARK_ESCALATE_RUNS - 1 }, true);
    expect(state).toEqual({ consecutiveDark: FEED_DARK_ESCALATE_RUNS, escalate: true });
  });

  test('stays escalated past the threshold - the build stays red until someone fixes it', () => {
    expect(rollFeedDarkness({ consecutiveDark: 40 }, true).escalate).toBe(true);
  });

  test('ONE healthy run is the all-clear: the streak resets and the build goes green', () => {
    expect(rollFeedDarkness({ consecutiveDark: FEED_DARK_ESCALATE_RUNS + 3 }, false))
      .toEqual({ consecutiveDark: 0, escalate: false });
  });

  test('a cold/corrupt cache starts the streak at 1, never mid-way to a red', () => {
    expect(rollFeedDarkness(null, true).consecutiveDark).toBe(1);
    expect(rollFeedDarkness({}, true).consecutiveDark).toBe(1);
    expect(rollFeedDarkness({ consecutiveDark: 'lots' as unknown as number }, true).consecutiveDark).toBe(1);
    expect(rollFeedDarkness({ consecutiveDark: -5 }, true).consecutiveDark).toBe(1);
  });

  // Named for its function rather than the generic phrasing the decode-budget
  // rollover above already uses: the two pin the same property of two
  // different rollers, and identical bare titles make a grep-level duplicate
  // check unreadable even though Playwright keys uniqueness on the full
  // describe path and accepts both.
  test('rollFeedDarkness never mutates the persisted object it was handed', () => {
    const persisted = { consecutiveDark: 2 };
    rollFeedDarkness(persisted, true);
    expect(persisted).toEqual({ consecutiveDark: 2 });
  });

  test('the threshold itself is a warning-first choice, not a hair trigger', () => {
    expect(FEED_DARK_ESCALATE_RUNS).toBeGreaterThanOrEqual(3);
  });
});

test.describe('the darkness tripwire is wired into scripts/newsdesk.mjs', () => {
  const src = readFileSync(join(process.cwd(), 'scripts/newsdesk.mjs'), 'utf8');

  test('an empty press body counts as silent, not as a quiet hour', () => {
    expect(src).toMatch(/if \(r\.value\.length === 0\) pressSilent\+\+/);
    expect(src).toMatch(/pressSilent\+\+;\s*console\.error/);
  });

  test('warnings use the ::warning:: annotation so they surface in the Actions summary', () => {
    expect(src).toContain('::warning::newsdesk');
  });

  test('the escalation is an ::error:: and a non-zero exit', () => {
    expect(src).toContain('::error::newsdesk has been fully dark');
    expect(src).toMatch(/if \(cache\.feedHealth\.escalate\) \{[\s\S]*?process\.exit\(1\)/);
  });

  test('the streak is persisted BEFORE the exit, or the counter could never reach the threshold', () => {
    // The call site, not the function definition.
    expect(src.indexOf('\nsaveCache(cache);')).toBeGreaterThan(0);
    expect(src.indexOf('\nsaveCache(cache);')).toBeLessThan(src.indexOf('cache.feedHealth.escalate'));
  });

  test('the streak survives a run that fires nothing - it is keyed off intake, not off outcomes', () => {
    expect(src.indexOf('cache.feedHealth = rollFeedDarkness')).toBeLessThan(src.indexOf('const { fired, reason } = decideFires'));
  });
});

test.describe('parseFeed (RSS/Atom, pure string parsing)', () => {
  test('parses an RSS 2.0 <item>', () => {
    const xml = '<rss><channel><item><title>Test Headline</title><link>https://example.com/a</link><pubDate>Thu, 16 Jul 2026 12:00:00 GMT</pubDate></item></channel></rss>';
    expect(parseFeed(xml)).toEqual([
      { title: 'Test Headline', link: 'https://example.com/a', pubDate: 'Thu, 16 Jul 2026 12:00:00 GMT', source: null },
    ]);
  });

  test('parses an Atom <entry> with href-style <link>', () => {
    const xml = '<feed><entry><title>Atom Title</title><link href="https://example.com/b"/><updated>2026-07-16T12:00:00Z</updated></entry></feed>';
    expect(parseFeed(xml)).toEqual([
      { title: 'Atom Title', link: 'https://example.com/b', pubDate: '2026-07-16T12:00:00Z', source: null },
    ]);
  });

  test('extracts the per-article outlet domain from a Google-News-style <source url> tag', () => {
    const xml = '<item><title>Bipartisan Medicare Bill Unites Congress</title><link>https://news.google.com/rss/articles/X</link><source url="https://legis1.com">Legis1</source></item>';
    expect(parseFeed(xml)[0].source).toBe('legis1.com');
  });

  test('drops entries missing a title or link', () => {
    const xml = '<item><title>No link here</title></item><item><link>https://example.com/c</link></item>';
    expect(parseFeed(xml)).toEqual([]);
  });

  test('decodes CDATA and HTML entities in titles', () => {
    const xml = '<item><title><![CDATA[Cruz &amp; Democrats push back]]></title><link>https://example.com/d</link></item>';
    expect(parseFeed(xml)[0].title).toBe('Cruz & Democrats push back');
  });
});
