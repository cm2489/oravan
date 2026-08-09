import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  BILL_TYPES,
  RECENT_WINDOW_MAX_STALE_DAYS,
  assessRecentWindow,
  mapStatus,
} from '../scripts/congress-fetch.mjs';
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

/*
 * THE TRIPWIRE THE ABOVE TEST CANNOT BE (2026-08-09).
 *
 * The pin above proves the sort STRING is right in this repo's source. It
 * cannot prove the sort was HONORED on the wire - and honoring is what broke
 * for a week in July 2026. Congress.gov ignored the ignored form silently: a
 * 200, a full page of well-formed bills, no error anywhere. scripts/
 * hot-bills.mjs consumed it blind, refreshed the OLDEST hundred bills of the
 * Congress twice a day, printed "100 refreshed", and exited 0 green from
 * 07-16 to 07-23. Only the DATES in the page can tell the difference, so the
 * job now reads them before spending ~100 detail requests on the window.
 */
test.describe('assessRecentWindow (the recent-window recency tripwire)', () => {
  const now = Date.parse('2026-08-09T12:00:00Z');
  const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString().slice(0, 10);
  const page = (...dates: string[]) => dates.map((updateDate, i) => ({ type: 'HR', number: `${i}`, updateDate }));

  test('a genuinely recent window passes and reports how fresh it is', () => {
    const r = assessRecentWindow(page(daysAgo(0), daysAgo(3), daysAgo(9)), { now });
    expect(r.ok).toBe(true);
    expect(r.newest).toBe(daysAgo(0));
    expect(r.staleDays).toBe(0);
    expect(r.reason).toBe(null);
  });

  test('the NEWEST entry decides, not the order the page arrived in', () => {
    // Defensive: the predicate must not itself assume the sort worked.
    const r = assessRecentWindow(page(daysAgo(400), daysAgo(2), daysAgo(600)), { now });
    expect(r.ok).toBe(true);
    expect(r.newest).toBe(daysAgo(2));
  });

  test('the July 2026 regression is caught: a page of Jan-2025 resolutions', () => {
    // Live-verified during the incident: the ignored sort returned bills last
    // touched ~18 months earlier.
    const r = assessRecentWindow(page('2025-01-14', '2025-01-13', '2025-01-09'), { now });
    expect(r.ok).toBe(false);
    expect(r.newest).toBe('2025-01-14');
    expect(r.staleDays).toBeGreaterThan(500);
    expect(r.reason).toContain('not sorted newest-first');
  });

  test('a long recess is NOT an outage - the threshold is generous on purpose', () => {
    // Congress goes quiet for weeks; updateDate does not stop moving across
    // ~19,000 bills for a month. Anything inside the limit must pass.
    expect(assessRecentWindow(page(daysAgo(RECENT_WINDOW_MAX_STALE_DAYS - 1)), { now }).ok).toBe(true);
    expect(assessRecentWindow(page(daysAgo(RECENT_WINDOW_MAX_STALE_DAYS)), { now }).ok).toBe(true);
    expect(assessRecentWindow(page(daysAgo(RECENT_WINDOW_MAX_STALE_DAYS + 1)), { now }).ok).toBe(false);
  });

  test('the threshold is weeks, not days - it must never red on an ordinary quiet stretch', () => {
    expect(RECENT_WINDOW_MAX_STALE_DAYS).toBeGreaterThanOrEqual(14);
  });

  test('an empty window fails - "no bills at all" is never a healthy answer here', () => {
    expect(assessRecentWindow([], { now })).toEqual({
      ok: false, newest: null, staleDays: null, reason: 'the window came back empty',
    });
    expect(assessRecentWindow(undefined, { now }).ok).toBe(false);
  });

  test('a window with no parseable updateDate fails rather than passing on a guess', () => {
    const r = assessRecentWindow([{ type: 'HR', number: '1' }, { type: 'S', number: '2', updateDate: 'soon' }], { now });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no parseable updateDate');
  });

  test('full ISO timestamps and bare dates both parse, and bare dates are read as UTC', () => {
    expect(assessRecentWindow([{ updateDate: '2026-08-09T11:00:00Z' }], { now }).ok).toBe(true);
    // A bare date must not be read in local time, or a westward runner would
    // score today's page as tomorrow's.
    expect(assessRecentWindow([{ updateDate: '2026-08-09' }], { now }).staleDays).toBe(0);
  });

  test('a future-dated update never reads as stale (the check is one-directional)', () => {
    expect(assessRecentWindow([{ updateDate: '2026-09-01' }], { now })).toMatchObject({ ok: true, staleDays: 0 });
  });
});

test.describe('hot-bills.mjs refuses to spend on a stale window', () => {
  const src = readFileSync(join(process.cwd(), 'scripts/hot-bills.mjs'), 'utf8');

  test('the window is checked BEFORE the refresh loop and before the write', () => {
    const check = src.indexOf('assessRecentWindow(recent');
    expect(check).toBeGreaterThan(src.indexOf('await fetchRecentlyUpdated'));
    expect(check).toBeLessThan(src.indexOf('for (const u of recent)'));
    // The call site, not the import.
    expect(check).toBeLessThan(src.indexOf("writeFileSync('data/bills.json'"));
  });

  test('a bad window is an ::error:: and a non-zero exit - not a warning it writes over', () => {
    expect(src).toMatch(/if \(!window\.ok\) \{[\s\S]*?::error::[\s\S]*?process\.exit\(1\)/);
  });

  test('the comment cites the July 2026 incident it exists for', () => {
    expect(src).toMatch(/2026-07-16/);
    expect(src).toMatch(/congress-fetch\.mjs/);
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

/*
 * Hot-bill schedule phasing (2026-08-08). The refresh job used to run at
 * '0 17' / '0 22' UTC. Congress.gov publishes day D's floor actions on D+1
 * between 13:35 and 14:00 UTC (measured 6/6 consecutive legislative days
 * from senate.gov's per-day floor XML Last-Modified headers, 13:35:27 to
 * 13:55:29; corroborated by this repo's corpus, absent from 08:30-10:10 UTC
 * commits and present in 12:15-17:42 ones), so the first pass sat three
 * hours behind a record that was already published.
 *
 * These pin the PROPERTIES the re-phasing bought, not the literal strings,
 * so a future retune only has to keep the reasoning true:
 *   - nothing fires before the publication band has closed (GitHub cron on
 *     this repo drifts +17 min to +3h27m but NEVER fires early, so the
 *     earliest safe minute is the invariant that matters);
 *   - no slot sits at :00 or :30, where the scheduler's backlog - and
 *     therefore its drift - is worst.
 * The workflow's own schedule comment carries the full derivation.
 */
test.describe('hot-bills.yml is phased to the floor-record publication window', () => {
  const yml = readFileSync(join(process.cwd(), '.github/workflows/hot-bills.yml'), 'utf8');
  const crons = [...yml.matchAll(/-\s*cron:\s*'(\d+)\s+(\d+)\s+\*\s+\*\s+\*'/g)].map((m) => ({
    minute: Number(m[1]),
    hour: Number(m[2]),
    utcMinutes: Number(m[2]) * 60 + Number(m[1]),
  }));

  test('the workflow still schedules exactly two daily passes', () => {
    expect(crons).toHaveLength(2);
  });

  test('the earliest pass fires at or after 13:47 UTC - the latest observed publication (13:55) is covered by drift, never by firing early', () => {
    const earliest = Math.min(...crons.map((c) => c.utcMinutes));
    expect(earliest).toBeGreaterThanOrEqual(13 * 60 + 47);
  });

  test('no pass sits on the top of the hour or the half hour', () => {
    for (const c of crons) {
      expect(c.minute % 30, `cron minute ${c.minute}`).not.toBe(0);
    }
  });

  test('both passes stay clear of the 07:30 UTC nightly sync', () => {
    for (const c of crons) {
      expect(Math.abs(c.utcMinutes - (7 * 60 + 30)), `cron ${c.hour}:${c.minute}`).toBeGreaterThan(60);
    }
  });
});
