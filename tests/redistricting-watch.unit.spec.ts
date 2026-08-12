import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// Relative import of the plain .mjs module - same pattern as
// tests/verify-salt.unit.spec.ts importing lib/salt.mjs: the logic tested
// here is exactly what scripts/check-redistricting-watch.mjs runs weekly
// against the live RDH sitemap.
import {
  RDH_STATE_SITEMAP_URL,
  STANDING_ISSUE_TITLE,
  BULK_MIN_STATES,
  parseStateSitemap,
  diffWatch,
  isStructuralFailure,
  isBulkRepublish,
  renderStatusBoard,
  renderChangeComment,
  statesWithDetections,
} from '../lib/redistricting-watch.mjs';

/*
 * Pins the RDH monitoring tripwire (S24, §9.1(f) item 3): a tracked state's
 * lastmod moving must be FLAGGED, an unchanged lastmod must stay SILENT, and
 * a total-parse-failure shape must be treated as a structural failure, not
 * "nothing changed." Fixture XML mirrors a real fetch of
 * https://redistrictingdatahub.org/state-sitemap.xml (verified live
 * 2026-07-06 via direct curl - see docs/solutions/
 * two-clock-district-boundaries.md), including states this repo doesn't
 * track, to prove the diff only reacts to tracked entries.
 */

function sitemapFixture(entries: Array<{ slug: string; lastmod: string }>): string {
  const urls = entries
    .map(
      ({ slug, lastmod }) =>
        `\t<url>\n\t\t<loc>https://redistrictingdatahub.org/state/${slug}/</loc>\n\t\t<lastmod>${lastmod}</lastmod>\n\t</url>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
}

function watchEntry(overrides: Partial<{ rdh_url: string; rdh_lastmod: string }> = {}) {
  return {
    status: 'locked',
    note: 'fixture entry',
    rdh_url: 'https://redistrictingdatahub.org/state/texas/',
    rdh_lastmod: '2026-04-02T19:29:36+00:00',
    verified: '2026-07-06',
    ...overrides,
  };
}

test.describe('RDH_STATE_SITEMAP_URL', () => {
  test('points at the verified real sitemap, not the un-fed "What\'s New" page', () => {
    expect(RDH_STATE_SITEMAP_URL).toBe('https://redistrictingdatahub.org/state-sitemap.xml');
  });
});

test.describe('parseStateSitemap', () => {
  test('extracts slug -> lastmod for every /state/{slug}/ entry', () => {
    const xml = sitemapFixture([
      { slug: 'texas', lastmod: '2026-04-02T19:29:36+00:00' },
      { slug: 'north-carolina', lastmod: '2026-04-02T16:34:57+00:00' },
    ]);
    const result = parseStateSitemap(xml);
    expect(result.get('texas')).toBe('2026-04-02T19:29:36+00:00');
    expect(result.get('north-carolina')).toBe('2026-04-02T16:34:57+00:00');
    expect(result.size).toBe(2);
  });

  test('ignores non-state entries (e.g. /state/national/) without erroring', () => {
    const xml = sitemapFixture([
      { slug: 'national', lastmod: '2026-03-04T17:11:41+00:00' },
      { slug: 'texas', lastmod: '2026-04-02T19:29:36+00:00' },
    ]);
    const result = parseStateSitemap(xml);
    expect(result.get('national')).toBe('2026-03-04T17:11:41+00:00');
    expect(result.get('texas')).toBe('2026-04-02T19:29:36+00:00');
  });

  test('empty or unrelated XML yields an empty map, not a crash', () => {
    expect(parseStateSitemap('<urlset></urlset>').size).toBe(0);
    expect(parseStateSitemap('').size).toBe(0);
  });
});

test.describe('diffWatch', () => {
  test('a changed lastmod is FLAGGED', () => {
    const committed = { TX: watchEntry({ rdh_lastmod: '2026-04-02T19:29:36+00:00' }) };
    const fresh = new Map([['texas', '2026-08-01T00:00:00+00:00']]);
    const { changed, missing } = diffWatch(committed, fresh);
    expect(changed).toEqual([
      {
        state: 'TX',
        prevLastmod: '2026-04-02T19:29:36+00:00',
        newLastmod: '2026-08-01T00:00:00+00:00',
        url: 'https://redistrictingdatahub.org/state/texas/',
      },
    ]);
    expect(missing).toEqual([]);
  });

  test('an unchanged lastmod stays SILENT', () => {
    const committed = { TX: watchEntry({ rdh_lastmod: '2026-04-02T19:29:36+00:00' }) };
    const fresh = new Map([['texas', '2026-04-02T19:29:36+00:00']]);
    const { changed, missing } = diffWatch(committed, fresh);
    expect(changed).toEqual([]);
    expect(missing).toEqual([]);
  });

  test('multiple tracked states: only the changed one is reported, untouched ones stay silent', () => {
    const committed = {
      TX: watchEntry({ rdh_url: 'https://redistrictingdatahub.org/state/texas/', rdh_lastmod: 'A' }),
      CA: watchEntry({ rdh_url: 'https://redistrictingdatahub.org/state/california/', rdh_lastmod: 'B' }),
    };
    const fresh = new Map([
      ['texas', 'A'], // unchanged
      ['california', 'B-new'], // changed
    ]);
    const { changed, missing } = diffWatch(committed, fresh);
    expect(changed.map((c) => c.state)).toEqual(['CA']);
    expect(missing).toEqual([]);
  });

  test('a tracked state absent from the fresh fetch is reported as missing, not silently unchanged', () => {
    const committed = { LA: watchEntry({ rdh_url: 'https://redistrictingdatahub.org/state/louisiana/' }) };
    const fresh = new Map([['texas', '2026-04-02T19:29:36+00:00']]); // no louisiana entry at all
    const { changed, missing } = diffWatch(committed, fresh);
    expect(changed).toEqual([]);
    expect(missing).toEqual(['LA']);
  });
});

test.describe('isStructuralFailure', () => {
  test('every tracked state missing = structural failure', () => {
    expect(isStructuralFailure(['TX', 'CA', 'LA'], 3)).toBe(true);
  });

  test('some (not all) tracked states missing = real news, not a structural failure', () => {
    expect(isStructuralFailure(['LA'], 3)).toBe(false);
  });

  test('nothing missing = not a structural failure', () => {
    expect(isStructuralFailure([], 3)).toBe(false);
  });

  test('a zero-state watch file is never "anomalous" (nothing to be missing from)', () => {
    expect(isStructuralFailure([], 0)).toBe(false);
  });
});

/*
 * Standing-issue rendering (2026-08-12). The watch used to file one issue per
 * changed state with no issue-level dedupe; nine accumulated in six weeks,
 * eight of them (#119-#126) from ONE upstream event - RDH bulk-touched eight
 * state pages within 28 minutes on 2026-07-24. These pin the replacement:
 * one rolling pinned issue, its body a status board rebuilt every run, one
 * comment per detecting run, and an explicit "this is a republish, not N map
 * events" call-out on a bulk run. The renderers live in the lib (not the
 * workflow YAML) precisely so they can be asserted here instead of only ever
 * running on a Monday at 08:00 UTC.
 */

/** The real 2026-07-24 batch, verbatim from data/redistricting-watch.json. */
const BULK_2026_07_24 = [
  { state: 'MO', prevLastmod: 'old', newLastmod: '2026-07-24T16:19:33+00:00', url: 'https://redistrictingdatahub.org/state/missouri/' },
  { state: 'NC', prevLastmod: 'old', newLastmod: '2026-07-24T16:20:08+00:00', url: 'https://redistrictingdatahub.org/state/north-carolina/' },
  { state: 'TX', prevLastmod: 'old', newLastmod: '2026-07-24T16:20:40+00:00', url: 'https://redistrictingdatahub.org/state/texas/' },
  { state: 'AL', prevLastmod: 'old', newLastmod: '2026-07-24T16:42:28+00:00', url: 'https://redistrictingdatahub.org/state/alabama/' },
  { state: 'FL', prevLastmod: 'old', newLastmod: '2026-07-24T16:44:42+00:00', url: 'https://redistrictingdatahub.org/state/florida/' },
  { state: 'OH', prevLastmod: 'old', newLastmod: '2026-07-24T16:46:49+00:00', url: 'https://redistrictingdatahub.org/state/ohio/' },
  { state: 'TN', prevLastmod: 'old', newLastmod: '2026-07-24T16:47:16+00:00', url: 'https://redistrictingdatahub.org/state/tennessee/' },
];

test.describe('isBulkRepublish', () => {
  test('the real 2026-07-24 batch (7 of 10, ~28 minutes apart) reads as a republish', () => {
    expect(isBulkRepublish(BULK_2026_07_24, 10)).toBe(true);
  });

  test('one state moving on its own is never a republish, however many are tracked', () => {
    const one = [BULK_2026_07_24[0]];
    expect(isBulkRepublish(one, 10)).toBe(false);
    expect(isBulkRepublish(one, 1)).toBe(false);
  });

  test('just under the state floor stays quiet even when the timestamps cluster', () => {
    expect(BULK_MIN_STATES).toBe(6);
    expect(isBulkRepublish(BULK_2026_07_24.slice(0, BULK_MIN_STATES - 1), 10)).toBe(false);
    expect(isBulkRepublish(BULK_2026_07_24.slice(0, BULK_MIN_STATES), 10)).toBe(true);
  });

  test('enough states but spread across days is real news, not a republish', () => {
    const spread = BULK_2026_07_24.map((c, i) => ({
      ...c,
      newLastmod: `2026-07-${String(10 + i).padStart(2, '0')}T16:00:00+00:00`,
    }));
    expect(isBulkRepublish(spread, 10)).toBe(false);
  });

  test('6 clustered states out of a much larger tracked set is not "site-wide"', () => {
    expect(isBulkRepublish(BULK_2026_07_24, 50)).toBe(false);
  });

  test('an unparseable timestamp says nothing rather than guessing', () => {
    const broken = BULK_2026_07_24.map((c, i) => (i === 0 ? { ...c, newLastmod: 'not-a-date' } : c));
    expect(isBulkRepublish(broken, 10)).toBe(false);
  });

  test('degenerate inputs never throw', () => {
    expect(isBulkRepublish([], 10)).toBe(false);
    expect(isBulkRepublish(BULK_2026_07_24, 0)).toBe(false);
    // The workflow feeds this straight from JSON.parse($CHANGED); a
    // non-array must not crash a run that is otherwise fine.
    expect(isBulkRepublish(null as never, 10)).toBe(false);
  });
});

test.describe('renderStatusBoard', () => {
  const committed = {
    TX: watchEntry({ rdh_url: 'https://redistrictingdatahub.org/state/texas/', rdh_lastmod: 'TX-MOD' }),
    LA: {
      ...watchEntry({ rdh_url: 'https://redistrictingdatahub.org/state/louisiana/', rdh_lastmod: 'LA-MOD' }),
      status: 'new-map-litigated',
      checked: '2026-08-03',
    },
  };

  test('one row per tracked state, carrying status, note date, last detection and the baseline', () => {
    const md = renderStatusBoard(committed, '2026-08-12T09:00:00Z');
    expect(md).toContain('| State | Status | Note verified | Last detected | RDH lastmod |');
    expect(md).toContain('| [LA](https://redistrictingdatahub.org/state/louisiana/) | new-map-litigated | 2026-07-06 | 2026-08-03 | `LA-MOD` |');
    expect(md).toContain('## Tracked states (2)');
  });

  test('a state that has never fired shows an explicit dash, not a blank cell', () => {
    // TX has no `checked` field here: polled every run, never changed since
    // the seed. A blank cell would read as "never looked at".
    const md = renderStatusBoard(committed, '2026-08-12T09:00:00Z');
    expect(md).toContain('| [TX](https://redistrictingdatahub.org/state/texas/) | locked | 2026-07-06 | — | `TX-MOD` |');
    expect(md).toContain('`—` means "polled, never changed since the seed"');
  });

  test('dates the board and says the body is rewritten, so nobody hand-edits it', () => {
    const md = renderStatusBoard(committed, '2026-08-12T09:00:00Z');
    expect(md).toContain('Board as of 2026-08-12');
    expect(md).toMatch(/rewrites this body every run/);
    expect(md).toMatch(/\*\*Leave it open\*\*/);
  });

  test('the standing title the workflow looks up is a single exact string', () => {
    expect(STANDING_ISSUE_TITLE).toBe('Redistricting watch (standing)');
  });

  test('a pipe in hand-authored data cannot break the table out of its columns', () => {
    const md = renderStatusBoard(
      { TX: { ...watchEntry(), status: 'locked | disputed' } },
      '2026-08-12T09:00:00Z'
    );
    expect(md).toContain('locked \\| disputed');
  });
});

test.describe('renderChangeComment', () => {
  test('names every changed state with its prev -> new hop and the page to go read', () => {
    const md = renderChangeComment(
      [
        {
          state: 'LA',
          prevLastmod: '2026-07-24T16:46:14+00:00',
          newLastmod: '2026-07-27T22:30:40+00:00',
          url: 'https://redistrictingdatahub.org/state/louisiana/',
        },
      ],
      10,
      '2026-08-03T08:00:00Z'
    );
    expect(md).toContain('### RDH map-page changes — 2026-08-03');
    expect(md).toContain('1 of 10 tracked states moved in this run.');
    expect(md).toContain('| LA | `2026-07-24T16:46:14+00:00` | `2026-07-27T22:30:40+00:00` | https://redistrictingdatahub.org/state/louisiana/ |');
  });

  test('a single-state run carries NO republish claim', () => {
    const md = renderChangeComment(
      [{ state: 'LA', prevLastmod: 'a', newLastmod: '2026-07-27T22:30:40+00:00', url: 'u' }],
      10,
      '2026-08-03T08:00:00Z'
    );
    expect(md).not.toMatch(/republish/i);
  });

  test('the 2026-07-24-shaped batch is called what it is: a republish, not N map events', () => {
    const md = renderChangeComment(BULK_2026_07_24, 10, '2026-07-27T08:00:00Z');
    expect(md).toContain('**This reads as an RDH site-wide republish, not 7 map events.**');
    expect(md).toContain('#119–#126');
    // 16:19:33 -> 16:47:16 is 27.7 minutes, rounded.
    expect(md).toContain('all within 28 minute(s) of each other');
  });
});

test.describe('statesWithDetections', () => {
  test('only states whose `checked` field was written by a detection run', () => {
    const committed = {
      TX: watchEntry({ rdh_lastmod: 'TX-MOD' }), // seeded, never fired
      LA: {
        ...watchEntry({ rdh_url: 'https://redistrictingdatahub.org/state/louisiana/', rdh_lastmod: 'LA-MOD' }),
        checked: '2026-08-03',
      },
    };
    expect(statesWithDetections(committed)).toEqual([
      {
        state: 'LA',
        status: 'locked',
        checked: '2026-08-03',
        rdhLastmod: 'LA-MOD',
        url: 'https://redistrictingdatahub.org/state/louisiana/',
      },
    ]);
  });

  test('an empty or never-fired watch file yields an empty list, not a crash', () => {
    expect(statesWithDetections({})).toEqual([]);
    expect(statesWithDetections({ TX: watchEntry() })).toEqual([]);
  });
});

test.describe('the committed watch file still matches what the renderers assume', () => {
  test('every entry carries the fields the status board renders', () => {
    const committed = JSON.parse(
      readFileSync(join(process.cwd(), 'data/redistricting-watch.json'), 'utf8')
    );
    const states = Object.keys(committed);
    expect(states.length).toBeGreaterThan(0);
    for (const s of states) {
      expect(typeof committed[s].status, `${s}.status`).toBe('string');
      expect(typeof committed[s].verified, `${s}.verified`).toBe('string');
      expect(typeof committed[s].rdh_lastmod, `${s}.rdh_lastmod`).toBe('string');
      expect(typeof committed[s].rdh_url, `${s}.rdh_url`).toBe('string');
    }
    // No empty cells, no "undefined" leaking into the issue body.
    expect(renderStatusBoard(committed, '2026-08-12T09:00:00Z')).not.toContain('undefined');
  });
});
