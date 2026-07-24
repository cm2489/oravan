import { expect, test } from '@playwright/test';
import { BILL_TYPES, mapStatus } from '../scripts/congress-fetch.mjs';
import { TRACKED_TYPES, findCitations } from '../scripts/newsdesk-match.mjs';

/*
 * Pins for the 2026-07-23 hot-bill-visibility fixes. Each of these guards a
 * failure that made big, talked-about legislation invisible on the site.
 */

test.describe('Congress.gov sort-parameter encoding (the inert recent-pass bug)', () => {
  test('a SPACE in the sort value serializes to the "+" the API requires; a literal "+" would break it', () => {
    // Congress.gov expects `sort=updateDate+desc` on the wire, where "+" is
    // the URL encoding of a space. URLSearchParams encodes a literal "+" as
    // %2B, which the API silently ignores — live-verified 2026-07-23: the
    // ignored form returned Jan-2025 bills; the correct form returned
    // today's floor bills. The fetch layer must therefore pass a SPACE.
    const good = new URL('https://api.congress.gov/v3/bill/119');
    good.searchParams.set('sort', 'updateDate desc');
    expect(good.search).toContain('sort=updateDate+desc');

    const broken = new URL('https://api.congress.gov/v3/bill/119');
    broken.searchParams.set('sort', 'updateDate+desc');
    expect(broken.search).toContain('sort=updateDate%2Bdesc');
  });
});

test.describe('tracked bill types include concurrent resolutions', () => {
  test('BILL_TYPES and TRACKED_TYPES agree and cover hconres/sconres', () => {
    // War Powers fights and budget resolutions ride on concurrent
    // resolutions; excluding them made H.Con.Res.38 structurally
    // unfetchable. Simple resolutions stay out by design.
    for (const t of ['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres']) {
      expect(BILL_TYPES.has(t), `BILL_TYPES ${t}`).toBe(true);
      expect(TRACKED_TYPES.has(t), `TRACKED_TYPES ${t}`).toBe(true);
    }
    expect(BILL_TYPES.has('hres')).toBe(false);
    expect(BILL_TYPES.has('sres')).toBe(false);
    expect([...BILL_TYPES].sort()).toEqual([...TRACKED_TYPES].sort());
  });

  test('findCitations resolves concurrent resolutions and still rejects simple resolutions', () => {
    expect(findCitations('House to vote on H.Con.Res. 38 war powers measure')).toEqual([
      { type: 'hconres', number: '38', slug: 'hconres-38-119' },
    ]);
    expect(findCitations('S. Con. Res. 12 budget resolution advances')).toEqual([
      { type: 'sconres', number: '12', slug: 'sconres-12-119' },
    ]);
    // Simple resolutions remain untracked - never a partial/wrong match.
    expect(findCitations('H. Res. 12 adopted on party lines')).toEqual([]);
  });
});

test.describe('mapStatus markup coverage (the gate admits real committee action)', () => {
  test('both Congress.gov spellings map to markup', () => {
    expect(mapStatus('Committee Consideration and Mark-up Session Held')).toBe('markup');
    expect(mapStatus('Committee markup held')).toBe('markup');
  });
});

test.describe('floor-activity status mapping (the buried-vote bug)', () => {
  test('recorded floor votes and live consideration map to floor_vote, not committee', () => {
    // Every string below is real Congress.gov action text from a bill that
    // was actively on a chamber floor while the corpus called it 'committee'
    // (2026-07-23: H.Con.Res. 89 in House debate, S.J.Res. 172's discharge
    // vote). At 'committee' they score 0.45 — below the moving floor — and
    // are gated out of decoding entirely, so the bill in the news has no page.
    expect(
      mapStatus('POSTPONED PROCEEDINGS - At the conclusion of debate on H. Con. Res. 89, the Chair put the question')
    ).toBe('floor_vote');
    expect(
      mapStatus('Motion to discharge Senate Committee on Foreign Relations rejected by Yea-Nay Vote. 47 - 48. Record Vote Number: 187.')
    ).toBe('floor_vote');
    expect(mapStatus('Considered as unfinished business.')).toBe('floor_vote');
  });

  test('committee roll calls still read as markup, never floor_vote', () => {
    // Committee votes use "Yeas and Nays", never the floor's "Yea-Nay Vote"
    // + "Record Vote Number" pairing - the distinction the branch relies on.
    expect(mapStatus('Ordered to be Reported by the Yeas and Nays: 25 - 20.')).toBe('markup');
    expect(mapStatus('Committee Consideration and Mark-up Session Held')).toBe('markup');
  });

  test('plain referral is untouched', () => {
    expect(mapStatus('Referred to the House Committee on Foreign Affairs.')).toBe('committee');
  });
});
