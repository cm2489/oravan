import { expect, test } from '@playwright/test';
import { SITE_ORIGIN } from '../lib/site';
import { corpus, expectDataStaleAt, movingSlugsAt, slugOf, stableAcross } from './corpus';
import { callTool } from './helpers';

/*
 * S10: the 5 MCP tools themselves, hit over the live route the same way an
 * agent would (tools/call), in both locales, against real corpus fixtures -
 * no mocking, since the whole point is that this reads the same baked JSON
 * the site renders from.
 *
 * Fixture: hr-2701-119 ("Fallen Servicemembers Religious Heritage
 * Restoration Act", sponsor Debbie Wasserman Schultz / W000797, status
 * floor_vote, topic national_security) is a real, currently-decoded bill in
 * data/bills.json + data/bills-es.json - chosen because it has a full
 * ai_sections decode (incl. cost chips), a resolvable sponsor, and issue
 * tags, in both languages.
 */

const BILL_SLUG = 'hr-2701-119';
const SPONSOR_BIOGUIDE = 'W000797';
const FIXTURE_TOPIC = 'national_security';
/* A word from the fixture's OFFICIAL title, so it narrows the match set in
 * both locales - localizeBill only overlays the AI decode, never the
 * congressional title. */
const FIXTURE_KEYWORD = 'servicemembers';
/* search_bills' own `limit` ceiling (lib/core/mcp-tools.ts's zod schema).
 * The tool has no offset/cursor, so a result deeper than this is
 * unreachable by any caller - which is exactly why the assertions below
 * never assume a bill sits inside a window. */
const SEARCH_MAX_LIMIT = 50;

/*
 * `locale` defaults to 'en' so every pre-existing English call site below is
 * unchanged; ES call sites pass it explicitly. Post-#46 fix: the envelope's
 * prose (source/ai_label/license) is now a real locale pair, not the same
 * English text with only canonical_url swapped - the license-text
 * assertion below is the one that actually distinguishes the two ("public
 * domain" only appears in the English string; "dominio público" only in
 * the Spanish one). "Congress.gov" and "CC BY" stay untranslated by design
 * (a proper noun and a license identifier), so those two assertions hold
 * for both locales unchanged.
 */
function expectMeta(
  meta: Record<string, unknown>,
  canonicalPath: string,
  aiContent: boolean,
  locale: 'en' | 'es' = 'en'
) {
  expect(typeof meta.as_of).toBe('string');
  expect(new Date(meta.as_of as string).toString()).not.toBe('Invalid Date');
  expect(meta.source).toContain('Congress.gov');
  expect(meta.canonical_url).toBe(`${SITE_ORIGIN}${canonicalPath}`);
  // No query params on the citation URL, ever (same rule as the site's own
  // share/canonical URLs).
  expect(meta.canonical_url as string).not.toContain('?');
  if (aiContent) {
    expect(meta.ai_label).toBeTruthy();
    expect(meta.license).toMatch(/CC BY/);
    if (locale === 'es') expect(meta.ai_label).toMatch(/generad[oa] por IA/i);
  } else {
    expect(meta.ai_label).toBeNull();
    expect(meta.license).toMatch(locale === 'es' ? /dominio público/i : /public domain/i);
  }
}

test.describe('lookup_representatives', () => {
  test('single-district ZIP, English', async ({ request }) => {
    const result = await callTool(request, 'lookup_representatives', { zip: '78501', locale: 'en' });
    const data = result.structuredContent!;
    expect(data.needs_address).toBe(false);
    expect(data.refine_hint).toBeNull();
    const names = (data.representatives as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['Monica De La Cruz', 'John Cornyn', 'Ted Cruz'])
    );
    // Every rep carries a portrait URL - a field this tool adds beyond the
    // raw legislator record.
    for (const r of data.representatives as Array<{ portrait_url: string }>) {
      expect(r.portrait_url).toContain('unitedstates.github.io');
    }
    expectMeta(data.meta as Record<string, unknown>, '/reps', false);
  });

  test('single-district ZIP, Spanish envelope + locale-prefixed canonical_url', async ({ request }) => {
    const result = await callTool(request, 'lookup_representatives', { zip: '78501', locale: 'es' });
    const data = result.structuredContent!;
    expectMeta(data.meta as Record<string, unknown>, '/es/reps', false, 'es');
    expect(data.reps_url).toContain('/es/reps?zip=78501');
  });

  test('split ZIP: needs_address true, refine_hint present, no address refinement attempted', async ({
    request,
  }) => {
    const result = await callTool(request, 'lookup_representatives', { zip: '10001', locale: 'en' });
    const data = result.structuredContent!;
    expect(data.needs_address).toBe(true);
    expect(data.refine_hint).toContain('reps?zip=10001');
    expect(data.refine_hint).toMatch(/never stores or logs/i);
    expect((data.districts as unknown[]).length).toBeGreaterThan(1);
  });

  // Same class of gap as the citation envelope (found alongside it, fixed in
  // the same PR): refine_hint is user-relayable prose that used to ignore
  // `locale` entirely.
  test('split ZIP, Spanish: refine_hint is Spanish prose with the /es reps URL', async ({ request }) => {
    const result = await callTool(request, 'lookup_representatives', { zip: '10001', locale: 'es' });
    const data = result.structuredContent!;
    expect(data.needs_address).toBe(true);
    expect(data.refine_hint).toContain('/es/reps?zip=10001');
    expect(data.refine_hint).toMatch(/nunca guarda ni registra/i);
  });

  test('bad ZIP: clean tool error, not a crash', async ({ request }) => {
    const result = await callTool(request, 'lookup_representatives', { zip: '00000', locale: 'en' });
    expect(result.isError).toBe(true);
  });

  // Same class of gap as refine_hint/the envelope: toolError() messages are
  // relayable prose too, and used to ignore `locale` (fixed in the same PR).
  test('bad ZIP, Spanish: the clean tool error is Spanish prose, not English', async ({ request }) => {
    const result = await callTool(request, 'lookup_representatives', { zip: '00000', locale: 'es' });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/No se encontraron datos/i);
  });

  // S24 groundwork (the project records §9.1(f)):
  // FL-20 is a real, currently-vacant seat baked into data/legislators.json;
  // ZIP 33313 maps to it alone. An agent reading this response must see the
  // vacancy explicitly, not infer it from a shorter-than-expected list.
  test('vacant seat: FL-20 is named explicitly, not silently omitted', async ({ request }) => {
    const result = await callTool(request, 'lookup_representatives', { zip: '33313', locale: 'en' });
    const data = result.structuredContent!;
    expect(data.vacancies).toEqual([{ state: 'FL', district: 20 }]);
    // The two senators are unaffected and still returned normally.
    const names = (data.representatives as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Rick Scott', 'Ashley Moody']));
    // The departed member is never returned as if still serving.
    expect(names.some((n) => n.includes('Cherfilus'))).toBe(false);
  });

  test('occupied district: vacancies is an empty array, not omitted', async ({ request }) => {
    const result = await callTool(request, 'lookup_representatives', { zip: '78501', locale: 'en' });
    const data = result.structuredContent!;
    expect(data.vacancies).toEqual([]);
  });
});

test.describe('get_bill', () => {
  test('resolves by slug, English: full decode + envelope + act_url', async ({ request }) => {
    const result = await callTool(request, 'get_bill', { slug: BILL_SLUG, locale: 'en' });
    const bill = (result.structuredContent!.bill as Record<string, unknown>);
    expect(bill.slug).toBe(BILL_SLUG);
    expect(bill.headline).toBeTruthy();
    expect(bill.ai_generated).toBe(true);
    const decoded = bill.decoded as Record<string, unknown>;
    expect(decoded.tldr).toBeTruthy();
    expect(decoded.cost_chips).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(bill.status).toBe('floor_vote');
    // The label retired its forecast 2026-07-25 (pre-launch audit): the
    // corpus carries no forward-looking scheduled dates, so "Heading to a
    // vote" claimed a schedule the record cannot support — and on nine bills
    // whose motions had been REJECTED it contradicted the action text printed
    // beside it. The status key is unchanged; only what we assert it MEANS.
    expect(bill.status_label).toBe('On the floor calendar');
    expect(['now', 'moving', 'radar']).toContain(bill.urgency_band);
    expect((bill.sponsor as { name: string }).name).toBe('Debbie Wasserman Schultz');
    expect(bill.congress_gov_url).toContain('congress.gov');
    expect(bill.url).toBe(`${SITE_ORIGIN}/bills/${BILL_SLUG}`);
    expect(bill.act_url).toBe(bill.url); // the only "act" link this tool ever returns
    expectMeta(result.structuredContent!.meta as Record<string, unknown>, `/bills/${BILL_SLUG}`, true);
  });

  test('resolves by slug, Spanish: decode is the ES translation, not English', async ({ request }) => {
    const result = await callTool(request, 'get_bill', { slug: BILL_SLUG, locale: 'es' });
    const bill = result.structuredContent!.bill as Record<string, unknown>;
    expect(bill.headline).toContain('judías');
    expectMeta(result.structuredContent!.meta as Record<string, unknown>, `/es/bills/${BILL_SLUG}`, true, 'es');
  });

  test('resolves by citation, most-recent-Congress tie-break', async ({ request }) => {
    const result = await callTool(request, 'get_bill', { citation: 'H.R. 2701', locale: 'en' });
    expect((result.structuredContent!.bill as { slug: string }).slug).toBe(BILL_SLUG);
  });

  test('neither slug nor citation: clean error, not a crash', async ({ request }) => {
    const result = await callTool(request, 'get_bill', { locale: 'en' });
    expect(result.isError).toBe(true);
  });

  test('unknown slug: clean error', async ({ request }) => {
    const result = await callTool(request, 'get_bill', { slug: 'hr-99999999-119' });
    expect(result.isError).toBe(true);
  });

  test('unknown slug, Spanish: the clean error is Spanish prose', async ({ request }) => {
    const result = await callTool(request, 'get_bill', { slug: 'hr-99999999-119', locale: 'es' });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/No se encontró ningún proyecto de ley/i);
  });
});

/*
 * search_bills returns a WINDOW, not the whole match set: most-urgent-first,
 * capped at `limit` (default 20, max 50), with no offset to page past it.
 * These tests therefore assert the contract - the filter selects by topic,
 * the window is sorted, the envelope discloses AI - and never that a named
 * fixture sits inside a window it does not control.
 *
 * 2026-07-31: the topic test used to assert exactly that, and went red on
 * main when the corpus outgrew it. Nothing regressed - hr-2701-119's last
 * action is 2025-12-09, so its urgency decayed to the floor while the
 * nightly sync kept adding fresher national_security bills above it: rank 12
 * of 309 matches on 07-28, rank 38 of 334 three days later. The fix is to
 * reach the fixture through a filter narrow enough that the window cannot
 * hide it, and to assert that narrowness rather than trust it.
 */
test.describe('search_bills', () => {
  test('topic filter finds the fixture bill, sorted, both locales', async ({ request }) => {
    for (const locale of ['en', 'es'] as const) {
      const result = await callTool(request, 'search_bills', { topic: FIXTURE_TOPIC, locale });
      const data = result.structuredContent!;
      const results = data.results as Array<{
        slug: string;
        ai_generated: boolean;
        urgency_score: number;
        topics: Array<{ id: string }>;
      }>;
      expect((data.total_matches as number)).toBeGreaterThan(0);
      expect(results.length).toBeGreaterThan(0);
      expect(data.topic).toBe(FIXTURE_TOPIC);
      // The filter is real, not just non-empty: every result carries the topic.
      for (const r of results) expect(r.topics.map((t) => t.id)).toContain(FIXTURE_TOPIC);
      // "sorted": most urgent first, the same rule the site's feeds use. The
      // scores are rounded to 3 decimals (lib/urgency.mjs), so this is an
      // exact check, not a tolerance one.
      const scores = results.map((r) => r.urgency_score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
      // Some AI-decoded results present -> envelope discloses it; a search
      // across an undecoded corner would not force a false label.
      const hasAi = results.some((r) => r.ai_generated);
      expectMeta(data.meta as Record<string, unknown>, locale === 'es' ? '/es/bills' : '/bills', hasAi, locale);

      // The fixture, reached through that same topic filter - narrowed by a
      // title keyword so the whole match set fits inside one window. The
      // total_matches assertion is what makes the next line window-proof:
      // when every match is returned, "the fixture is in results" IS "the
      // fixture matches the filter". If a future corpus pushes this past
      // SEARCH_MAX_LIMIT, that assertion fails first and says so - narrow
      // the keyword, never widen the window.
      const narrowed = await callTool(request, 'search_bills', {
        topic: FIXTURE_TOPIC,
        query: FIXTURE_KEYWORD,
        limit: SEARCH_MAX_LIMIT,
        locale,
      });
      const narrowData = narrowed.structuredContent!;
      const narrowResults = narrowData.results as Array<{ slug: string; topics: Array<{ id: string }> }>;
      expect((narrowData.total_matches as number)).toBeLessThanOrEqual(SEARCH_MAX_LIMIT);
      expect(narrowResults.length).toBe(narrowData.total_matches as number);
      expect(narrowResults.some((r) => r.slug === BILL_SLUG)).toBe(true);
    }
  });

  test('free-text query matches the fixture bill by title keyword', async ({ request }) => {
    const result = await callTool(request, 'search_bills', {
      query: FIXTURE_KEYWORD,
      limit: SEARCH_MAX_LIMIT,
      locale: 'en',
    });
    const data = result.structuredContent!;
    const results = data.results as Array<{ slug: string }>;
    // Same window-proofing as above: assert the full match set came back
    // before asserting the fixture is in it.
    expect((data.total_matches as number)).toBeLessThanOrEqual(SEARCH_MAX_LIMIT);
    expect(results.length).toBe(data.total_matches as number);
    expect(results.some((r) => r.slug === BILL_SLUG)).toBe(true);
  });

  test('active_only excludes terminal (signed/vetoed) bills', async ({ request }) => {
    const result = await callTool(request, 'search_bills', { status: 'signed', active_only: true, limit: 5 });
    expect((result.structuredContent!.results as unknown[]).length).toBe(0);
  });

  test('no matches: honest empty, not an error', async ({ request }) => {
    const result = await callTool(request, 'search_bills', { query: 'zzzznonexistentbillzzz' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent!.results).toEqual([]);
    expect(result.structuredContent!.total_matches).toBe(0);
  });
});

/*
 * whats_moving branches on the live corpus by design: a hot legislative week
 * must list exactly the Act-now-recent bills, and an empty week must carry
 * the honest quiet_week/data_stale verdict - never padding, never a false
 * quiet. The expectation is fully corpus-derived via tests/corpus.ts (the
 * same idiom freshness.spec.ts uses), NOT pinned to an empty corpus: this
 * test was originally authored against a chronically stale corpus and
 * hardcoded `bills: []`, which turned deterministically red the first
 * genuinely hot week after the 2026-07 pipeline repairs (#88/#90) landed
 * H.R. 6955 at floor-vote freshness - the site was right, the pin was wrong.
 *
 * 2026-07-16 (audit §5 item 4) history, still load-bearing: the
 * quiet_week/data_stale split reads THREE signals (lastRun, the sync
 * cursor, and the corpus's own newest activity - lib/freshness-state.ts's
 * emptyStateVerdict), so the empty-week branch computes all three rather
 * than assuming quiet_week.
 */
test.describe('whats_moving', () => {
  const MOVING_STABLE = stableAcross((at) => [movingSlugsAt(at), expectDataStaleAt(at)]);

  test('mirrors the corpus exactly: a hot week lists the Act-now-recent bills, an empty week is honest - never padded, never falsely quiet', async ({ request }) => {
    test.skip(!MOVING_STABLE, 'corpus sits at an urgency/recency boundary - expectation could flip between build and assert');
    const expected = movingSlugsAt(Date.now());
    const expectDataStale = expectDataStaleAt(Date.now());

    const result = await callTool(request, 'whats_moving', { locale: 'en' });
    const data = result.structuredContent!;
    const returned = data.bills as Array<{ slug: string; ai_generated: boolean }>;
    expect(returned.map((b) => b.slug)).toEqual(expected);
    if (expected.length === 0) {
      expect(data.quiet_week).toBe(!expectDataStale);
      expect(data.data_stale).toBe(expectDataStale);
    } else {
      // A populated result needs no verdict - and every listed bill cleared
      // getTopActions' ai_headline gate, so each carries the AI label.
      expect(data.quiet_week).toBe(false);
      expect(data.data_stale).toBe(false);
      for (const b of returned) expect(b.ai_generated).toBe(true);
    }
    expect(data.days).toBe(7);
    // Empty result = non-AI, no label to disclose; any listed bill = AI teasers.
    expectMeta(data.meta as Record<string, unknown>, '/', expected.length > 0);
  });

  test('never silently backfills to hit a limit or ignore a topic filter', async ({ request }) => {
    const args = { topic: 'housing', days: 3 } as const;
    test.skip(
      !stableAcross((at) => movingSlugsAt(at, args)),
      'corpus sits at an urgency/recency boundary - expectation could flip between build and assert'
    );
    const expected = movingSlugsAt(Date.now(), args);

    const result = await callTool(request, 'whats_moving', { ...args, locale: 'es' });
    const data = result.structuredContent!;
    expect((data.bills as Array<{ slug: string }>).map((b) => b.slug)).toEqual(expected);
    expect(data.topic).toBe('housing');
    expectMeta(data.meta as Record<string, unknown>, '/es', expected.length > 0, 'es');
  });
});

/*
 * get_representative carries a window too: the sponsor's 5 most recent
 * bills, newest last action first, a HARD slice in lib/core/mcp.ts with no
 * limit param and no paging. The same unstated assumption that took
 * search_bills red sat here one nightly sync from firing - W000797 has
 * exactly 5 sponsored bills in the corpus and BILL_SLUG (last action
 * 2025-12-09) is the oldest of them, so the next bill she sponsors evicts
 * the fixture. Derive the window from the corpus rather than naming a
 * member of it.
 */
const SPONSOR_WINDOW = 5;
const expectedSponsored = corpus
  .filter((b) => b.sponsor_bioguide_id === SPONSOR_BIOGUIDE)
  .sort((a, b) => (b.last_action_date ?? '').localeCompare(a.last_action_date ?? ''))
  .slice(0, SPONSOR_WINDOW)
  .map(slugOf);

test.describe('get_representative', () => {
  test('full record + recent sponsored teasers, English', async ({ request }) => {
    const result = await callTool(request, 'get_representative', { bioguide: SPONSOR_BIOGUIDE, locale: 'en' });
    const rep = result.structuredContent!.representative as Record<string, unknown>;
    expect(rep.name).toBe('Debbie Wasserman Schultz');
    expect(rep.portrait_url).toContain(SPONSOR_BIOGUIDE);
    // Facts only: no scorecard/rating fields exist on this payload.
    expect(rep).not.toHaveProperty('score');
    expect(rep).not.toHaveProperty('rating');
    expect(rep).not.toHaveProperty('grade');
    const sponsored = rep.recent_sponsored as Array<{ slug: string; ai_generated: boolean }>;
    // Exactly the corpus's own newest-first window - stronger than "the
    // fixture is in there somewhere", and it cannot rot as she sponsors more.
    expect(sponsored.map((b) => b.slug)).toEqual(expectedSponsored);
    const hasAi = sponsored.some((b) => b.ai_generated);
    expectMeta(result.structuredContent!.meta as Record<string, unknown>, '/reps', hasAi);
  });

  test('Spanish locale localizes sponsored-bill headlines and carries the Spanish envelope', async ({
    request,
  }) => {
    // This assertion needs the fixture's known ES decode ("judías"), so it
    // needs the fixture inside the sponsor's 5-bill window. Skip loudly
    // rather than fail obscurely when the corpus evicts it - the fix then is
    // to re-anchor BILL_SLUG on a currently-windowed decoded bill.
    test.skip(
      !expectedSponsored.includes(BILL_SLUG),
      `corpus pushed ${BILL_SLUG} out of ${SPONSOR_BIOGUIDE}'s ${SPONSOR_WINDOW}-bill sponsored window - re-anchor the ES decode fixture`
    );
    const result = await callTool(request, 'get_representative', { bioguide: SPONSOR_BIOGUIDE, locale: 'es' });
    const rep = result.structuredContent!.representative as Record<string, unknown>;
    const sponsored = rep.recent_sponsored as Array<{
      slug: string;
      headline: string | null;
      ai_generated: boolean;
    }>;
    const match = sponsored.find((b) => b.slug === BILL_SLUG);
    expect(match?.headline).toContain('judías');
    const hasAi = sponsored.some((b) => b.ai_generated);
    expectMeta(result.structuredContent!.meta as Record<string, unknown>, '/es/reps', hasAi, 'es');
  });

  test('unknown bioguide: clean error', async ({ request }) => {
    const result = await callTool(request, 'get_representative', { bioguide: 'Z999999' });
    expect(result.isError).toBe(true);
  });

  test('unknown bioguide, Spanish: the clean error is Spanish prose', async ({ request }) => {
    const result = await callTool(request, 'get_representative', { bioguide: 'Z999999', locale: 'es' });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/No se encontró ningún representante/i);
  });
});
