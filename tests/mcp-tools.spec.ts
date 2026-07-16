import { expect, test } from '@playwright/test';
import { SITE_ORIGIN } from '../lib/site';
import syncState from '../data/sync-state.json';
import bills from '../data/bills.json';
import { FRESHNESS_DEAD_WINDOW_DAYS, freshnessAgeDays, freshnessState } from '../lib/freshness-state';
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

  // S24 groundwork (docs/ideation/2026-07-05-build-gtm-strategy.md §9.1(f)):
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
    expect(bill.status_label).toBe('Heading to a vote');
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

test.describe('search_bills', () => {
  test('topic filter finds the fixture bill, sorted, both locales', async ({ request }) => {
    for (const locale of ['en', 'es'] as const) {
      const result = await callTool(request, 'search_bills', { topic: 'national_security', locale });
      const data = result.structuredContent!;
      const results = data.results as Array<{ slug: string; ai_generated: boolean }>;
      expect(results.some((r) => r.slug === BILL_SLUG)).toBe(true);
      expect((data.total_matches as number)).toBeGreaterThan(0);
      expect(data.topic).toBe('national_security');
      // Some AI-decoded results present -> envelope discloses it; a search
      // across an undecoded corner would not force a false label.
      const hasAi = results.some((r) => r.ai_generated);
      expectMeta(data.meta as Record<string, unknown>, locale === 'es' ? '/es/bills' : '/bills', hasAi, locale);
    }
  });

  test('free-text query matches the fixture bill by title keyword', async ({ request }) => {
    const result = await callTool(request, 'search_bills', { query: 'servicemembers', locale: 'en' });
    const results = result.structuredContent!.results as Array<{ slug: string }>;
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

// This corpus's freshest last_action_date trails "today" by enough that no
// bill currently clears the S3 absolute urgency floor (pinned independently
// against the real data at authoring time) - the real, undoctored honesty
// case the spec calls for, not a mock. `data.bills` is empty either way;
// which of quiet_week/data_stale that empty result carries is corpus-derived
// below (mirroring lib/freshness-state.ts's emptyStateVerdict exactly)
// rather than hardcoded, so this test keeps tracking the site's real
// behavior as the nightly sync rewrites data/ instead of silently drifting
// from it.
//
// 2026-07-16 (audit §5 item 4): this invariant legitimately changed.
// emptyStateVerdict used to look ONLY at checkedAt/lastRun ("did the job
// run"), so this test could hardcode quiet_week=true/data_stale=false once
// and trust it. Now the sync cursor and the corpus's own newest activity
// independently gate the verdict too, and both are real fields the pipeline
// can leave stale even on nights lastRun itself looks fresh (the exact bug
// the audit found) - so the expectation has to be computed from the same
// three signals, not assumed.
const newestActionDate = (bills as { last_action_date: string | null }[]).reduce(
  (max, b) => (b.last_action_date && b.last_action_date > max ? b.last_action_date : max),
  ''
);
const expectDataStale =
  freshnessState(syncState.lastRun) !== 'fresh' ||
  freshnessAgeDays(syncState.lastSync) > FRESHNESS_DEAD_WINDOW_DAYS ||
  freshnessAgeDays(newestActionDate) > FRESHNESS_DEAD_WINDOW_DAYS;

test.describe('whats_moving', () => {
  test('honest empty state matches the real corpus\'s freshness signals - never padded, never falsely quiet', async ({ request }) => {
    const result = await callTool(request, 'whats_moving', { locale: 'en' });
    const data = result.structuredContent!;
    expect(data.bills).toEqual([]);
    expect(data.quiet_week).toBe(!expectDataStale);
    expect(data.data_stale).toBe(expectDataStale);
    expect(data.days).toBe(7);
    // An empty, non-AI result carries no AI label - nothing to disclose.
    expectMeta(data.meta as Record<string, unknown>, '/', false);
  });

  test('never silently backfills to hit a limit or ignore a topic filter', async ({ request }) => {
    const result = await callTool(request, 'whats_moving', { topic: 'housing', days: 3, locale: 'es' });
    const data = result.structuredContent!;
    expect(data.bills).toEqual([]);
    expect(data.topic).toBe('housing');
    expectMeta(data.meta as Record<string, unknown>, '/es', false, 'es');
  });
});

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
    expect(sponsored.some((b) => b.slug === BILL_SLUG)).toBe(true);
    const hasAi = sponsored.some((b) => b.ai_generated);
    expectMeta(result.structuredContent!.meta as Record<string, unknown>, '/reps', hasAi);
  });

  test('Spanish locale localizes sponsored-bill headlines and carries the Spanish envelope', async ({
    request,
  }) => {
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
