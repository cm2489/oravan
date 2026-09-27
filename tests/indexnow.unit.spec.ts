import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { routing } from '../i18n/routing';
import { billSlug as coreBillSlug, getAllBills, getBill, getLegislator } from '../lib/core';
import { getAllNominations, nominationSlug as coreNominationSlug } from '../lib/core/nominations';
import { getMoments, momentClaimsVehicles, vehicleKind } from '../lib/moments';
import { SITE_ORIGIN } from '../lib/site';
import {
  DATA_FILES,
  DEFAULT_LOCALE,
  INDEXNOW_ENDPOINT,
  INDEXNOW_KEY,
  LOCALES,
  PAGE_INVISIBLE_BILL_FIELDS,
  TODAY_ORDER_BILL_FIELD,
  URL_CAP,
  billSlug,
  buildPayload,
  deriveChangedPaths,
  localizedUrl,
  localizedUrls,
  nominationSlug,
  siteOriginFromSource,
} from '../scripts/indexnow-urls.mjs';
import { describeResponse, headRef, shouldPost } from '../scripts/indexnow-ping.mjs';

/*
 * THE INDEXNOW PING (the 2026-09-27 audit, SY-19: indexed but not ranking).
 *
 * After a data commit deploys, sync-bills.yml and hot-bills.yml send the
 * shared IndexNow endpoint the URLs of the pages that commit changed. What
 * these tests defend:
 *
 *   1. THE MAPPING. A page is "changed" when a record it renders changed -
 *      never because a freshness stamp moved, or the ping becomes a nightly
 *      copy of sitemap.xml. Each data file's rule is pinned on fixtures.
 *   2. THE URLS. Both locales, in exactly the shape sitemap.xml lists them
 *      (lib/hreflang.ts's absoluteUrl), and never a page the site does not
 *      claim.
 *   3. THE KEY FILE. public/<key>.txt holds the key, is allowlisted, and is
 *      out of the locale proxy's reach.
 *   4. IT CAN NEVER COST A RUN, AND NEVER POSTS FROM ANYWHERE BUT MAIN. The
 *      script exits 0 on every path; the post gate is closed off Actions/main;
 *      the workflow steps are continue-on-error and sit after the deploy check.
 */

const REPO = process.cwd();

type Data = Record<string, unknown>;

const bill = (type: string, num: number, extra: Record<string, unknown> = {}) => ({
  full_identifier: `${type}-${num}-119`,
  congress_number: 119,
  bill_type: type,
  bill_number: num,
  title: `A bill ${type} ${num}`,
  status: 'committee',
  last_action_text: 'Referred to committee.',
  last_action_date: '2026-09-01',
  sponsor_bioguide_id: 'A000001',
  urgency_score: 0.2,
  ...extra,
});

/** A small, internally consistent data/ — every DATA_FILES entry present. */
function fixture(): Data {
  return {
    'bills.json': [
      bill('hr', 1),
      bill('s', 2, { sponsor_bioguide_id: 'B000002' }),
      bill('hr', 3, { sponsor_bioguide_id: 'Z999999' }), // sponsor not sitting
    ],
    'bills-es.json': { 'hr-1-119': { headline: 'Titular', summary: 'Resumen', sections: [] } },
    'coverage.json': { 'hr-1-119': [{ url: 'https://example.com/a', title: 'A story' }] },
    'floor-signals.json': { _meta: { fetched_at: '2026-09-27T08:00:00Z' }, signals: {}, nominations: {} },
    'votes.json': { _meta: { updatedAt: '2026-09-27T08:00:00Z' }, rollCalls: [], members: [] },
    'moments.json': { 'q-one': { name: { en: 'Q', es: 'P' }, vehicles: [{ slug: 's-2-119' }] } },
    'moment-updates.json': { _meta: { generated_at: '2026-09-27T08:00:00Z' }, 'q-one': [] },
    'nominations.json': [{ pn_number: '11', part_number: '00', congress_number: 119, status: 'received' }],
    'conversation.json': { _meta: { fetched_at: '2026-09-27T08:00:00Z' }, slugs: {} },
    'legislators.json': [{ bioguide: 'A000001' }, { bioguide: 'B000002' }],
  };
}

const bills = (d: Data) => d['bills.json'] as Array<Record<string, unknown>>;
const billIn = (d: Data, slug: string) => bills(d).find((b) => billSlug(b) === slug)!;
const BILL_HUBS = ['/', '/bills', '/today'];

/* ------------------------------------------------------------------ *
 * 1 · The mapping.
 * ------------------------------------------------------------------ */
test.describe('deriveChangedPaths: what counts as a changed page', () => {
  test('identical data changes nothing', () => {
    expect(deriveChangedPaths(fixture(), fixture())).toEqual([]);
  });

  test('freshness stamps alone change nothing (else every page changes every night)', () => {
    const after = fixture();
    (after['floor-signals.json'] as { _meta: object })._meta = { fetched_at: '2026-09-28T08:00:00Z' };
    (after['votes.json'] as { _meta: object })._meta = { updatedAt: '2026-09-28T08:00:00Z' };
    (after['moment-updates.json'] as { _meta: object })._meta = { generated_at: '2026-09-28T08:00:00Z' };
    (after['conversation.json'] as { _meta: object })._meta = { fetched_at: '2026-09-28T08:00:00Z' };
    expect(deriveChangedPaths(fixture(), after)).toEqual([]);
    // …and the files that exist only to stamp freshness are not read at all.
    for (const f of ['sync-state.json', 'floor-signals-checked.json', 'portrait-manifest.json']) {
      expect(DATA_FILES).not.toContain(f);
    }
  });

  test('a bill whose status moved: its page, its sitting sponsor, the bill hubs', () => {
    const after = fixture();
    Object.assign(billIn(after, 'hr-1-119'), { status: 'passed_house', last_action_text: 'Passed House.' });
    expect(deriveChangedPaths(fixture(), after)).toEqual([...BILL_HUBS, '/bills/hr-1-119', '/reps/A000001']);
  });

  test('fields no page renders do not count (decode bookkeeping, text versions, search inputs)', () => {
    const after = fixture();
    Object.assign(billIn(after, 'hr-1-119'), {
      decoded_at: '2026-09-27',
      decode_text_sha: 'abc',
      decode_text_verified_at: '2026-09-27',
      text_version_date: '2026-09-26',
      text_version_type: 'Engrossed',
      text_version_count: 3,
      news_query: 'q',
      press_names: ['x'],
    });
    expect(PAGE_INVISIBLE_BILL_FIELDS.length).toBe(8);
    expect(deriveChangedPaths(fixture(), after)).toEqual([]);
  });

  test('urgency_score alone re-pings /today, the one page it orders, and nothing else', () => {
    const after = fixture();
    billIn(after, 'hr-1-119').urgency_score = 0.9;
    expect(TODAY_ORDER_BILL_FIELD).toBe('urgency_score');
    expect(PAGE_INVISIBLE_BILL_FIELDS).not.toContain('urgency_score');
    expect(deriveChangedPaths(fixture(), after)).toEqual(['/today']);
  });

  test('a key reorder with no value change is not a change', () => {
    const after = fixture();
    const b = billIn(after, 'hr-1-119');
    const reordered = Object.fromEntries(Object.entries(b).reverse());
    (after['bills.json'] as unknown[])[0] = reordered;
    expect(deriveChangedPaths(fixture(), after)).toEqual([]);
  });

  test('a sponsor who holds no seat has no page to ping', () => {
    const after = fixture();
    billIn(after, 'hr-3-119').status = 'passed_house';
    expect(deriveChangedPaths(fixture(), after)).toEqual([...BILL_HUBS, '/bills/hr-3-119']);
  });

  test('a changed Big Question vehicle also changes that question page', () => {
    const after = fixture();
    billIn(after, 's-2-119').status = 'passed_senate';
    expect(deriveChangedPaths(fixture(), after)).toEqual([
      '/',
      '/bills',
      '/questions',
      '/today',
      '/questions/q-one',
      '/bills/s-2-119',
      '/reps/B000002',
    ]);
  });

  test('added and removed bills are both pinged (IndexNow accepts deletions)', () => {
    const after = fixture();
    (after['bills.json'] as unknown[]).push(bill('hr', 4));
    (after['bills.json'] as unknown[]).splice(2, 1); // drop hr-3
    const paths = deriveChangedPaths(fixture(), after);
    expect(paths).toContain('/bills/hr-4-119');
    expect(paths).toContain('/bills/hr-3-119');
  });

  test('a Spanish-only change pings the bill (both locales) and its sponsor, whose teasers are localized', () => {
    const after = fixture();
    (after['bills-es.json'] as Record<string, { summary: string }>)['hr-1-119'].summary = 'Resumen nuevo';
    expect(deriveChangedPaths(fixture(), after)).toEqual([...BILL_HUBS, '/bills/hr-1-119', '/reps/A000001']);
  });

  test('coverage, floor signals and roll calls change the bill page, not the sponsor page', () => {
    const cov = fixture();
    (cov['coverage.json'] as Record<string, unknown[]>)['hr-1-119'].push({ url: 'https://example.com/b', title: 'B' });
    expect(deriveChangedPaths(fixture(), cov)).toEqual([...BILL_HUBS, '/bills/hr-1-119']);

    const floor = fixture();
    (floor['floor-signals.json'] as { signals: Record<string, unknown> }).signals['s-2-119'] = { tier0: { quote: 'q' } };
    expect(deriveChangedPaths(fixture(), floor)).toEqual(['/', '/bills', '/questions', '/today', '/questions/q-one', '/bills/s-2-119']);

    const votes = fixture();
    (votes['votes.json'] as { rollCalls: unknown[] }).rollCalls.push({ id: 'h-119-2-300', bill: 'hr-1-119', result: 'Passed' });
    expect(deriveChangedPaths(fixture(), votes)).toEqual([...BILL_HUBS, '/bills/hr-1-119']);
  });

  test('a slug that names no bill page on either side is dropped, hubs and all', () => {
    const after = fixture();
    (after['coverage.json'] as Record<string, unknown[]>)['hr-999-119'] = [{ url: 'https://example.com/z' }];
    (after['moment-updates.json'] as Record<string, unknown>)['no-such-question'] = [{ text: 'x' }];
    expect(deriveChangedPaths(fixture(), after)).toEqual([]);
  });

  test('live updates change the question page and the question hubs only', () => {
    const after = fixture();
    (after['moment-updates.json'] as Record<string, unknown[]>)['q-one'].push({ date: '2026-09-27', text: 'x' });
    expect(deriveChangedPaths(fixture(), after)).toEqual(['/', '/questions', '/questions/q-one']);
  });

  test('a changed Big Question entry reaches its vehicles as a backlink, and fans out no further', () => {
    const after = fixture();
    (after['moments.json'] as Record<string, { name: { en: string } }>)['q-one'].name.en = 'Renamed';
    expect(deriveChangedPaths(fixture(), after)).toEqual(['/', '/questions', '/questions/q-one', '/bills/s-2-119']);
  });

  test('a nomination page is pinged only while a Big Question cites it', () => {
    const uncited = fixture();
    (uncited['nominations.json'] as Array<{ status: string }>)[0].status = 'confirmed';
    expect(deriveChangedPaths(fixture(), uncited)).toEqual([]);

    const cite = (d: Data) => {
      (d['moments.json'] as Record<string, unknown>)['q-two'] = {
        name: { en: 'N', es: 'N' },
        vehicles: [{ kind: 'nomination', slug: 'pn-11-119' }],
      };
      return d;
    };
    const before = cite(fixture());
    const after = cite(fixture());
    (after['nominations.json'] as Array<{ status: string }>)[0].status = 'confirmed';
    expect(deriveChangedPaths(before, after)).toEqual(['/', '/questions', '/questions/q-two', '/nominations/pn-11-119']);
  });

  test('the conversation lamp changes the news band on / and /bills, nothing else', () => {
    const after = fixture();
    (after['conversation.json'] as { slugs: Record<string, unknown> }).slugs['hr-1-119'] = { outlets7d: ['a'] };
    expect(deriveChangedPaths(fixture(), after)).toEqual(['/', '/bills']);
  });

  test('absent files never throw; a file new in this commit counts every entry as added', () => {
    expect(deriveChangedPaths({}, {})).toEqual([]);
    expect(deriveChangedPaths(null, null)).toEqual([]);
    const before = fixture();
    before['votes.json'] = null;
    const after = fixture();
    (after['votes.json'] as { rollCalls: unknown[] }).rollCalls.push({ id: 'h-119-2-1', bill: 'hr-1-119' });
    expect(deriveChangedPaths(before, after)).toEqual([...BILL_HUBS, '/bills/hr-1-119']);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · The URLs.
 * ------------------------------------------------------------------ */
test.describe('the URLs sent', () => {
  test('locales mirror i18n/routing.ts: English unprefixed, Spanish under /es', () => {
    expect(LOCALES).toEqual([...routing.locales]);
    expect(DEFAULT_LOCALE).toBe(routing.defaultLocale);
    expect(routing.localePrefix).toBe('as-needed');
  });

  test('each URL has the exact shape sitemap.xml lists (lib/hreflang.ts absoluteUrl)', () => {
    // lib/hreflang.ts cannot load outside Next (next-intl navigation), so the
    // shapes are the literals tests/sitemap.spec.ts pins against the built
    // sitemap - and tests/indexnow-key.spec.ts checks these same functions
    // against the real /sitemap.xml on the production build.
    expect(localizedUrl(SITE_ORIGIN, 'en', '/')).toBe('https://oravan.org');
    expect(localizedUrl(SITE_ORIGIN, 'es', '/')).toBe('https://oravan.org/es');
    expect(localizedUrl(SITE_ORIGIN, 'en', '/bills')).toBe('https://oravan.org/bills');
    expect(localizedUrl(SITE_ORIGIN, 'es', '/bills/hr-5582-119')).toBe('https://oravan.org/es/bills/hr-5582-119');
    expect(localizedUrl(SITE_ORIGIN, 'en', '/questions/iran-war-powers')).toBe('https://oravan.org/questions/iran-war-powers');
    expect(localizedUrl(SITE_ORIGIN, 'es', '/reps/A000001')).toBe('https://oravan.org/es/reps/A000001');
  });

  test('both locales, path by path, in priority order; the cap drops the tail', () => {
    const { urls, dropped } = localizedUrls('https://example.org', ['/', '/bills/a', '/reps/X']);
    expect(urls).toEqual([
      'https://example.org',
      'https://example.org/es',
      'https://example.org/bills/a',
      'https://example.org/es/bills/a',
      'https://example.org/reps/X',
      'https://example.org/es/reps/X',
    ]);
    expect(dropped).toBe(0);
    const capped = localizedUrls('https://example.org', ['/', '/bills/a', '/reps/X'], 3);
    expect(capped.urls).toEqual(['https://example.org', 'https://example.org/es', 'https://example.org/bills/a']);
    expect(capped.dropped).toBe(3);
    // The protocol's own per-request ceiling (indexnow.org/documentation).
    expect(URL_CAP).toBe(10_000);
  });

  test('the slug rules are the site\'s own, over the whole corpus', () => {
    for (const b of getAllBills()) expect(billSlug(b)).toBe(coreBillSlug(b));
    for (const n of getAllNominations()) expect(nominationSlug(n)).toBe(coreNominationSlug(n));
  });

  test('against the real data/: no change against itself, and every page it can name is one the sitemap claims', () => {
    const real: Data = {};
    for (const f of DATA_FILES) real[f] = JSON.parse(readFileSync(join(REPO, 'data', f), 'utf8'));
    expect(deriveChangedPaths(real, real)).toEqual([]);

    // Everything "added" from nothing: the widest list the real corpus can
    // yield. app/sitemap.ts itself cannot load outside Next (lib/freshness is
    // server-only), so each path is checked against the helpers and the
    // predicates that file builds its entries from.
    const everything = deriveChangedPaths({}, real);
    expect(everything.length).toBeGreaterThan(getAllBills().length);
    const sitemapSrc = readFileSync(join(REPO, 'app/sitemap.ts'), 'utf8');
    const staticBlock = /const STATIC_PATHS = \[([\s\S]*?)\] as const;/.exec(sitemapSrc);
    expect(staticBlock, 'STATIC_PATHS not found in app/sitemap.ts').toBeTruthy();
    const staticPaths = new Set([...staticBlock![1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
    const moments = getMoments();
    // A retired question's page 404s, which makes its ping a deletion notice
    // (IndexNow accepts those); every other question must be a listed one.
    const knownQuestion = new Set(moments.map((m) => m.id));
    const citedNomination = new Set(
      moments
        .filter((m) => momentClaimsVehicles(m))
        .flatMap((m) => m.vehicles.filter((v) => vehicleKind(v) === 'nomination').map((v) => v.slug))
    );
    const unclaimed = everything.filter((p) => {
      const [, kind, id] = p.split('/');
      if (!id) return !staticPaths.has(p);
      if (kind === 'bills') return !getBill(id);
      if (kind === 'reps') return !getLegislator(id);
      if (kind === 'questions') return !knownQuestion.has(id);
      if (kind === 'nominations') return !citedNomination.has(id);
      return true;
    });
    expect(unclaimed).toEqual([]);
  });

  test('the body is four public fields: host, key, key file URL, page URLs', () => {
    const urls = [`${SITE_ORIGIN}/bills/hr-1-119`];
    const body = buildPayload(SITE_ORIGIN, urls);
    expect(Object.keys(body).sort()).toEqual(['host', 'key', 'keyLocation', 'urlList']);
    expect(body.host).toBe('oravan.org');
    expect(body.host).toBe(new URL(SITE_ORIGIN).host);
    expect(body.key).toBe(INDEXNOW_KEY);
    expect(body.keyLocation).toBe(`${SITE_ORIGIN}/${INDEXNOW_KEY}.txt`);
    expect(body.urlList).toEqual(urls);
    expect(INDEXNOW_ENDPOINT).toBe('https://api.indexnow.org/indexnow');
  });

  test('the origin is read from lib/site.ts, the one place it lives', () => {
    expect(siteOriginFromSource(readFileSync(join(REPO, 'lib/site.ts'), 'utf8'))).toBe(SITE_ORIGIN);
    expect(siteOriginFromSource('nothing here')).toBeNull();
  });

  test('PAGE_INVISIBLE_BILL_FIELDS stay invisible, and only /today reads urgency_score', () => {
    // If this fails, a page started reading the field: take it off the list
    // in scripts/indexnow-urls.mjs (or widen what an urgency change pings) so
    // changes to it reach the pages that show it.
    const roots = ['app', 'components', 'lib'];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name)) files.push(full);
      }
    };
    for (const r of roots) walk(join(REPO, r));
    // Not page code: the type declarations; the MCP API (JSON for agents);
    // and the machine feeds (lib/core/feed.ts -> app/feed/*). None of them is
    // a sitemap page, so none is ever pinged.
    const notPages = [
      join(REPO, 'lib/types.ts'),
      join(REPO, 'app/api'),
      join(REPO, 'lib/core/mcp.ts'),
      join(REPO, 'lib/core/feed.ts'),
    ];
    const pageFiles = files.filter((f) => !notPages.some((p) => f === p || f.startsWith(`${p}/`)));
    expect(pageFiles.length).toBeGreaterThan(50);
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const readersOf = (field: string) =>
      pageFiles
        .filter((f) =>
          new RegExp(`\\.${field}\\b|['"\`]${field}['"\`]|\\b${field}\\s*[:,}]`).test(strip(readFileSync(f, 'utf8')))
        )
        .map((f) => f.slice(REPO.length + 1));
    expect(PAGE_INVISIBLE_BILL_FIELDS.flatMap((field) => readersOf(field).map((f) => `${f} reads ${field}`))).toEqual([]);
    expect(readersOf(TODAY_ORDER_BILL_FIELD)).toEqual(['lib/today.ts']);
  });
});

/* ------------------------------------------------------------------ *
 * 3 · The key file.
 * ------------------------------------------------------------------ */
test.describe('the IndexNow key file', () => {
  test('the key is 32 lowercase hex (inside the protocol\'s 8-128) and the file holds exactly it', () => {
    expect(INDEXNOW_KEY).toMatch(/^[0-9a-f]{32}$/);
    expect(readFileSync(join(REPO, 'public', `${INDEXNOW_KEY}.txt`), 'utf8')).toBe(INDEXNOW_KEY);
  });

  test('it is the only key-shaped file in public/ (a rotated key leaves no stale twin)', () => {
    const keyFiles = readdirSync(join(REPO, 'public')).filter((n) => /^[0-9a-f-]{8,128}\.txt$/i.test(n));
    expect(keyFiles).toEqual([`${INDEXNOW_KEY}.txt`]);
  });

  test('the public/ allowlist gate admits it', () => {
    const r = spawnSync(process.execPath, ['scripts/check-public-allowlist.mjs'], { cwd: REPO, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });

  test('the locale proxy never sees it (served as a static file, never locale-rewritten)', () => {
    const src = readFileSync(join(REPO, 'proxy.ts'), 'utf8');
    const m = /matcher:\s*'([^']+)'/.exec(src);
    expect(m, 'proxy.ts matcher not found').toBeTruthy();
    const pattern = JSON.parse(`"${m![1]}"`) as string; // unescape the TS string literal
    const matches = (path: string) => new RegExp(`^${pattern}/?$`).test(path);
    expect(matches('/bills/hr-1-119')).toBe(true); // sanity: pages do go through it
    expect(matches(`/${INDEXNOW_KEY}.txt`)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 4 · Never fatal, never from anywhere but main.
 * ------------------------------------------------------------------ */
test.describe('the ping script', () => {
  test('it posts only from GitHub Actions on main, and --dry-run always wins', () => {
    const main = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main' };
    expect(shouldPost(main, [])).toBe(true);
    expect(shouldPost(main, ['--dry-run'])).toBe(false);
    expect(shouldPost({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/pull/300/merge' }, [])).toBe(false);
    expect(shouldPost({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/feat/x' }, [])).toBe(false);
    expect(shouldPost({ GITHUB_REF: 'refs/heads/main' }, [])).toBe(false);
    expect(shouldPost({}, [])).toBe(false);
  });

  test('every documented status is described; only 200 and 202 read as sent', () => {
    expect(describeResponse(200).ok).toBe(true);
    expect(describeResponse(202).ok).toBe(true);
    for (const s of [400, 403, 422, 429, 500, 503]) {
      const d = describeResponse(s);
      expect(d.ok, String(s)).toBe(false);
      expect(d.message.length, String(s)).toBeGreaterThan(0);
    }
  });

  test('the commit comes from --head, then INDEXNOW_HEAD_SHA, then HEAD', () => {
    expect(headRef(['--head', 'abc'], { INDEXNOW_HEAD_SHA: 'def' })).toBe('abc');
    expect(headRef([], { INDEXNOW_HEAD_SHA: 'def' })).toBe('def');
    expect(headRef([], {})).toBe('HEAD');
    expect(headRef(['--head'], {})).toBe('HEAD');
  });

  // A minimal environment on purpose: CI runs this suite with
  // GITHUB_ACTIONS=true, and on a main dispatch GITHUB_REF=refs/heads/main,
  // so inheriting process.env could arm the real POST. --dry-run as well.
  const run = (args: string[]) =>
    spawnSync(process.execPath, ['scripts/indexnow-ping.mjs', ...args], {
      cwd: REPO,
      encoding: 'utf8',
      // Cast: Next's ambient types make NODE_ENV required on ProcessEnv.
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } as unknown as NodeJS.ProcessEnv,
    });

  test('an unresolvable commit exits 0 with a warning, sending nothing', () => {
    const r = run(['--dry-run', '--head', 'not-a-commit-anywhere']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::warning::indexnow:');
    expect(r.stdout).not.toMatch(/indexnow: (200|202) /);
  });

  test('a real commit (or a shallow checkout without its parent) exits 0 and does not send', () => {
    const r = run(['--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/not sending|nothing to send|cannot resolve/);
    expect(r.stdout).not.toMatch(/indexnow: (200|202) /);
  });
});

/* ------------------------------------------------------------------ *
 * 5 · The workflow steps.
 * ------------------------------------------------------------------ */
test.describe('where the ping runs', () => {
  const wf = (name: string) => readFileSync(join(REPO, '.github/workflows', name), 'utf8');
  const stepOf = (yml: string, name: string) => {
    const at = yml.indexOf(`- name: ${name}`);
    expect(at, `${name} step not found`).toBeGreaterThan(0);
    const rest = yml.slice(at);
    const next = rest.slice(1).search(/\n {6}- name:/);
    return { at, body: next === -1 ? rest : rest.slice(0, next + 1) };
  };

  for (const file of ['sync-bills.yml', 'hot-bills.yml']) {
    test(`${file}: after the deploy check, before the CI dispatch, and unable to fail the run`, () => {
      const yml = wf(file);
      const ping = stepOf(yml, 'Tell IndexNow which pages changed');
      const deploy = stepOf(yml, 'Verify the deploy landed');
      const dispatch = stepOf(yml, 'Dispatch CI against the pushed data');
      const commit = stepOf(yml, 'Commit data');

      expect(ping.at).toBeGreaterThan(commit.at);
      expect(ping.at).toBeGreaterThan(deploy.at);
      expect(ping.at).toBeLessThan(dispatch.at);

      expect(deploy.body).toContain('id: deploy');
      expect(ping.body).toContain(
        "if: steps.commit.outputs.changed == 'true' && github.ref == 'refs/heads/main' && steps.deploy.outcome == 'success'"
      );
      expect(ping.body).toContain('continue-on-error: true');
      expect(ping.body).toMatch(/timeout-minutes: \d+/);
      expect(ping.body).toContain('INDEXNOW_HEAD_SHA: ${{ steps.commit.outputs.sha }}');
      expect(ping.body).toContain('run: node scripts/indexnow-ping.mjs');
      // No secret: the key is public and nothing else is needed.
      expect(ping.body).not.toContain('secrets.');
    });
  }

  test('the hourly newsdesk does not ping (the protocol asks not to resubmit a URL many times a day)', () => {
    expect(wf('newsdesk.yml')).not.toContain('indexnow-ping.mjs');
  });
});
