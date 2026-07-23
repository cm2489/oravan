import { expect, test } from '@playwright/test';
// Pure, I/O-free module (no CONGRESS_API_KEY/ANTHROPIC_API_KEY, no network)
// - see scripts/newsdesk-match.mjs's header comment for the full match
// design this pins.
import {
  anyDataChanged,
  buildBillIndex,
  buildListIndex,
  decideFires,
  extractBillsThisWeekSlugs,
  extractFloorFeedSlugs,
  extractMostViewedSlugs,
  extractNicknameTokens,
  findCitations,
  hashHeadline,
  looksLegislative,
  matchLocal,
  matchNickname,
  mondayOfWeekET,
  parseFeed,
  prunePendingOutlets,
  summarizePendingOutlets,
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

// ---- tier-0 government feed parsers (samples mirror the live shapes
// ---- fetched read-only 2026-07-23) --------------------------------------

test.describe('extractFloorFeedSlugs (Congress.gov floor-today RSS: title IS the bill number)', () => {
  const HOUSE_FLOOR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>House Floor Today</title>
<item><title>H.R.8884</title><description><![CDATA[Removing Barriers to Work for Disabled Americans Act (07/23/2026)]]></description><link>https://www.congress.gov/bill/119th-congress/house-bill/8884</link></item>
<item><title>H.Con.Res.89</title><description><![CDATA[War powers resolution]]></description><link>https://www.congress.gov/bill/119th-congress/house-concurrent-resolution/89</link></item>
</channel></rss>`;

  test('extracts tracked bill numbers from item titles', () => {
    expect(extractFloorFeedSlugs(HOUSE_FLOOR_XML)).toEqual(['hr-8884-119']);
  });

  test('H.Con.Res (untracked type) is silently excluded, never mis-parsed as H.R.', () => {
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
    expect(extractBillsThisWeekSlugs(FLOORSCHEDULE_XML).sort()).toEqual(['hr-2715-119', 'hr-9770-119']);
  });

  test('untracked H. Con. Res. / H. Res. legis-nums are excluded', () => {
    const slugs = extractBillsThisWeekSlugs(FLOORSCHEDULE_XML);
    expect(slugs).not.toContain('hr-113-119');
    expect(slugs).not.toContain('hr-1438-119');
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
});

test.describe('hashHeadline (seen-headlines dedupe key)', () => {
  test('normalizes whitespace and case so near-identical entries collide on purpose', () => {
    expect(hashHeadline('Some Title', 'cbsnews.com')).toBe(hashHeadline('some   title  ', 'CBSNEWS.com'));
  });

  test('different outlets for the same title hash differently (per-outlet dedupe)', () => {
    expect(hashHeadline('Some Title', 'cbsnews.com')).not.toBe(hashHeadline('Some Title', 'foxnews.com'));
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
