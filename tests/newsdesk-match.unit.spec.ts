import { expect, test } from '@playwright/test';
// Pure, I/O-free module (no CONGRESS_API_KEY/ANTHROPIC_API_KEY, no network)
// - see scripts/newsdesk-match.mjs's header comment for the full match
// design this pins.
import {
  anyDataChanged,
  buildBillIndex,
  decideFires,
  findCitations,
  hashHeadline,
  looksLegislative,
  matchLocal,
  parseFeed,
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
