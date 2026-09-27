import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { compareLastActionDesc, foldSearchText } from '../lib/bill-search.mjs';
import { billSlug, getAllBills, localizeBill } from '../lib/core/bills';
import { formatCitation } from '../lib/format';
import { SITE_ORIGIN } from '../lib/site';
import type { Bill } from '../lib/types';

/*
 * feat/mcp-stdio-entry: the stdio transport (lib/mcp-stdio.ts + scripts/
 * mcp-stdio.mjs) built for Glama's MCP directory listing (glama.ai/mcp/
 * servers/cm2489/oravan), whose sandbox quality checks build-and-run the
 * server locally and speak stdio - proxying to the hosted Streamable HTTP
 * endpoint is explicitly rejected by their harness.
 *
 * Spawns the REAL entrypoint a client config would run - `npx tsx
 * scripts/mcp-stdio.mjs` - exactly as designed, and drives it with the
 * SDK's own Client + StdioClientTransport rather than importing
 * lib/mcp-stdio.ts directly, so this pins the actual child-process command
 * line an MCP client (Claude Desktop, Glama's sandbox, etc.) would be
 * configured with.
 *
 * `env: getDefaultEnvironment()` (not the ambient `process.env`) is
 * deliberate, not incidental: it's the SDK's own curated whitelist (HOME/
 * LOGNAME/PATH/SHELL/TERM/USER, no secrets) - passing it explicitly, rather
 * than relying on inheritance, is what actually proves the server needs
 * ZERO env vars/secrets to run, instead of merely not being tested against
 * a secret-bearing environment by accident.
 *
 * Runtime stays modest: a handful of focused tests (the handshake, the tool
 * list, one get_bill, and the search_bills rule since SY-21) on one shared connection
 * (`test.describe.serial` + a single spawned child, closed in
 * `afterAll`) rather than one spawn per test - startup (npx resolving tsx,
 * tsx transpiling the whole lib/core import graph) is the expensive part,
 * not the JSON-RPC calls themselves.
 */

test.describe.serial('MCP stdio entry (scripts/mcp-stdio.mjs)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  test.beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'scripts/mcp-stdio.mjs'],
      cwd: process.cwd(),
      env: getDefaultEnvironment(),
      stderr: 'ignore', // the "server ready" log line (lib/mcp-stdio.ts) - stderr only, never parsed
    });
    client = new Client({ name: 'oravan-stdio-ci-check', version: '1.0' });
    await client.connect(transport);
  });

  test.afterAll(async () => {
    await client?.close();
  });

  test('initialize handshake succeeds and identifies the server', () => {
    const info = client.getServerVersion();
    expect(info).toMatchObject({ name: 'oravan' });
    // Same literal version source as server.json/package.json - see
    // scripts/check-server-json.mjs's cross-check for the other half of
    // this pin.
    expect(info?.version).toBeTruthy();
  });

  test("tools/list returns exactly the 5 spec'd tools, each read-only and closed-world", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['get_bill', 'get_representative', 'lookup_representatives', 'search_bills', 'whats_moving'].sort()
    );
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} must be readOnlyHint:true`).toBe(true);
      expect(tool.annotations?.openWorldHint, `${tool.name} must be openWorldHint:false`).toBe(false);
    }
  });

  test('a real tools/call (get_bill) against the committed corpus returns the citation envelope', async () => {
    // Same fixture bill as tests/mcp-tools.spec.ts's HTTP-transport
    // coverage: hr-2701-119, a real, currently-decoded bill in
    // data/bills.json with a full ai_sections decode and a resolvable
    // sponsor - proves this transport reads the identical baked corpus,
    // not a second copy.
    const result = await client.callTool({ name: 'get_bill', arguments: { slug: 'hr-2701-119', locale: 'en' } });
    expect(result.isError).toBeFalsy();
    const bill = (result.structuredContent as Record<string, unknown>).bill as Record<string, unknown>;
    expect(bill.slug).toBe('hr-2701-119');
    expect(bill.ai_generated).toBe(true);
    const meta = (result.structuredContent as Record<string, unknown>).meta as Record<string, unknown>;
    expect(meta.source).toContain('Congress.gov');
    expect(meta.canonical_url).toBe(`${SITE_ORIGIN}/bills/hr-2701-119`);
    expect(meta.ai_label).toBeTruthy();
    expect(meta.license).toMatch(/CC BY/);
  });

  /*
   * search_bills over the real corpus (the 2026-09-27 audit, SY-21). The
   * tool used to match the whole query as ONE substring: "Iran war powers"
   * returned 1 bill while the corpus held 12, and "hconres 89" returned 0.
   * The rule itself is pinned on synthetic cases in
   * tests/bill-search.unit.spec.ts; these calls prove the tool is wired to
   * it, through the real entry and the real zod schema.
   *
   * Every expectation is derived from the corpus — the OFFICIAL title (a
   * re-decode never rewrites it), a naive per-word oracle, or a bill picked
   * by type — so a nightly sync cannot turn this red by rewording a summary.
   */
  async function search(args: Record<string, unknown>) {
    const result = await client.callTool({ name: 'search_bills', arguments: args });
    expect(result.isError, JSON.stringify(args)).toBeFalsy();
    const data = result.structuredContent as {
      results: Array<{ slug: string; urgency_score: number; last_action_date: string | null }>;
      total_matches: number;
    };
    return { ...data, slugs: data.results.map((r) => r.slug) };
  }
  const SEARCH_MAX_LIMIT = 50;

  test('search_bills: "Iran war powers" matches every word, not the phrase', async () => {
    const r = await search({ query: 'Iran war powers', limit: SEARCH_MAX_LIMIT, locale: 'en' });
    expect(r.total_matches).toBeLessThanOrEqual(SEARCH_MAX_LIMIT);
    expect(r.slugs.length).toBe(r.total_matches);

    // Every bill whose OFFICIAL title carries all three words is found.
    const byTitle = getAllBills().filter((b) =>
      ['iran', 'war', 'powers'].every((w) => b.title.toLowerCase().includes(w))
    );
    expect(byTitle.length).toBeGreaterThan(0);
    for (const b of byTitle) expect(r.slugs, billSlug(b)).toContain(billSlug(b));

    // An independent naive oracle: plain lower-case `includes` of each word
    // over the fields the tool searches. The tool finds at least that set.
    const naive = getAllBills().filter((b) => {
      const hay = [b.title, b.short_title, b.ai_headline, b.ai_summary].join(' ').toLowerCase();
      return ['iran', 'war', 'powers'].every((w) => hay.includes(w));
    });
    for (const b of naive) expect(r.slugs, billSlug(b)).toContain(billSlug(b));

    // Strictly more than the old whole-phrase rule (1 on 2026-09-27, when
    // this rule returned 13).
    const phrase = getAllBills().filter((b) =>
      [b.title, b.short_title, b.ai_headline, b.ai_summary].some((v) =>
        (v ?? '').toLowerCase().includes('iran war powers')
      )
    );
    expect(r.total_matches).toBeGreaterThan(phrase.length);
  });

  test('search_bills: a bill number in any common form returns exactly that bill, one bill of every type', async () => {
    const firstOfType = new Map<string, Bill>();
    for (const b of getAllBills()) if (!firstOfType.has(b.bill_type)) firstOfType.set(b.bill_type, b);
    expect(firstOfType.size).toBeGreaterThan(1);
    for (const b of firstOfType.values()) {
      const display = formatCitation(b.bill_type, b.bill_number); // "H.Con.Res. 89"
      const spaced = display.replace(/\./g, '. ').replace(/\s+/g, ' ').trim(); // "H. Con. Res. 89"
      const compact = `${b.bill_type}${b.bill_number}`; // "hconres89"
      for (const q of [display, spaced, compact, `${b.bill_type} ${b.bill_number}`, compact.toUpperCase()]) {
        const r = await search({ query: q, limit: SEARCH_MAX_LIMIT });
        expect(r.slugs, q).toContain(billSlug(b));
        // That type and number only (another Congress at most), never a
        // neighbour: "S. 89" must not return H.Con.Res. 89.
        for (const s of r.slugs) expect(s.startsWith(`${b.bill_type}-${b.bill_number}-`), `${q} -> ${s}`).toBe(true);
      }
      expect((await search({ query: billSlug(b) })).slugs).toEqual([billSlug(b)]);
    }
  });

  test('search_bills: the audit\'s "hconres 89" finds H.Con.Res. 89', async () => {
    test.skip(!getAllBills().some((b) => billSlug(b) === 'hconres-89-119'), 'hconres-89-119 is not in this corpus');
    for (const q of ['hconres 89', 'H.Con.Res. 89', 'H. Con. Res. 89', 'hconres89']) {
      expect((await search({ query: q })).slugs, q).toEqual(['hconres-89-119']);
    }
  });

  test('search_bills: Spanish ignores accents and searches the Spanish decode', async () => {
    const accented = await search({ query: 'Irán', limit: SEARCH_MAX_LIMIT, locale: 'es' });
    const plain = await search({ query: 'iran', limit: SEARCH_MAX_LIMIT, locale: 'es' });
    expect(accented.total_matches).toBeGreaterThan(0);
    expect(accented.total_matches).toBe(plain.total_matches);
    expect(accented.slugs).toEqual(plain.slugs);

    // The three longest words of a bill's SPANISH headline, accents folded
    // off and upper-cased, still find it in the es locale. Letters only, so
    // no word can read as a citation.
    const longestWords = (s: string) =>
      foldSearchText(s)
        .split(/[^\p{L}]+/u)
        .filter((w) => w.length > 4)
        .sort((a, b) => b.length - a.length)
        .slice(0, 3);
    const target = getAllBills()
      .map((b) => localizeBill(b, 'es'))
      .find(
        (b) =>
          b.ai_headline &&
          /[áéíóúñ]/i.test(b.ai_headline) &&
          b.ai_headline !== b.title &&
          longestWords(b.ai_headline).length === 3
      );
    test.skip(!target, 'no accented Spanish headline in this corpus');
    const query = longestWords(target!.ai_headline!).join(' ').toUpperCase();
    const found = await search({ query, limit: SEARCH_MAX_LIMIT, locale: 'es' });
    expect(found.total_matches, query).toBeGreaterThan(0);
    if (found.total_matches <= SEARCH_MAX_LIMIT) expect(found.slugs, query).toContain(billSlug(target!));
  });

  test('search_bills: topic names are searchable in the requested locale', async () => {
    const tagged = getAllBills().filter((b) => (b.issue_tags ?? []).includes('health')).length;
    expect(tagged).toBeGreaterThan(0);
    for (const [locale, messages] of [
      ['en', en],
      ['es', es],
    ] as const) {
      const label = messages.categories.health;
      const r = await search({ query: label, locale });
      expect(r.total_matches, `${locale} "${label}"`).toBeGreaterThanOrEqual(tagged);
    }
  });

  test('search_bills: most urgent first, ties broken by the most recent last action', async () => {
    const r = await search({ query: 'Iran', limit: SEARCH_MAX_LIMIT });
    expect(r.results.length).toBeGreaterThan(1);
    for (let i = 1; i < r.results.length; i++) {
      const [a, b] = [r.results[i - 1], r.results[i]];
      expect(a.urgency_score).toBeGreaterThanOrEqual(b.urgency_score);
      if (a.urgency_score === b.urgency_score) {
        expect(compareLastActionDesc(a.last_action_date, b.last_action_date), `${a.slug} before ${b.slug}`).toBeLessThanOrEqual(0);
      }
    }
  });

  test('search_bills: a query with nothing searchable filters nothing; a real miss is an honest empty', async () => {
    const all = (await search({ limit: 5 })).total_matches;
    expect((await search({ query: '...', limit: 5 })).total_matches).toBe(all);
    expect((await search({ query: '   ', limit: 5 })).total_matches).toBe(all);
    const miss = await search({ query: 'zzzznonexistentbillzzz' });
    expect(miss.results).toEqual([]);
    expect(miss.total_matches).toBe(0);
  });
});
