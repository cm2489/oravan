import { createMcpHandler } from 'mcp-handler';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { callerIp, createRateLimiter, readRostraKey } from '@/lib/ratelimit';
import { CATEGORIES } from '@/lib/taxonomy';
import { BILL_STATUSES } from '@/lib/types';
import {
  billNotFoundError,
  getBillDetail,
  getRepresentativeDetail,
  lookupRepresentatives,
  missingBillIdentifierError,
  noDistrictDataError,
  normalizeLocale,
  representativeNotFoundError,
  searchBills,
  whatsMoving,
} from '@/lib/core/mcp';

/*
 * Rostra's MCP server (S10). Five read-only tools over lib/core/mcp.ts's
 * pure functions, which read the same baked JSON the site's own pages read -
 * an agent's answer and a visitor's page can never disagree. No tool here
 * makes an outbound network call; the one the spec allows (Census address
 * refinement inside lookup_representatives) is deliberately deferred - see
 * lib/core/mcp.ts's lookupRepresentatives doc comment.
 *
 * Exactly these 5, per docs/ideation/2026-07-02-mcp-spec.md §2 and the
 * settled S10 scope call (KTD-6, closed under R16): lookup_representatives,
 * get_bill, search_bills, whats_moving, get_representative.
 *   - get_bill_coverage is cut. Not registered, not aliased - a request for
 *     it is simply an unknown tool, same as any other.
 *   - draft_call_script is never exposed here. get_bill's `act_url` link-out
 *     is the deliberate replacement (see lib/core/mcp.ts).
 * Every tool is readOnlyHint + openWorldHint:false (the spec's own design
 * rule, §2) - true here in the most literal sense: nothing in this file
 * performs I/O beyond reading process-local, build-time-baked JSON.
 *
 * Streamable HTTP only (SSE is disabled: the 2025-03-26 MCP spec deprecated
 * SSE-only transports), and stateless: no sessionIdGenerator, so every
 * request gets a fresh McpServer/transport pair and nothing survives
 * between requests. That statelessness is what makes this safe to run on
 * serverless compute with zero coordination - the same reasoning the rest
 * of the API surface already follows (see app/api/district/route.ts).
 *
 * Constitution check (CLAUDE.md "no server-side user data"), verified here
 * in code, not just in review:
 *  - No cookies: neither this handler nor mcp-handler's stateless path sets
 *    any Set-Cookie header.
 *  - No logging of request bodies or IPs: `verboseLogs` stays false (the
 *    library's default - set explicitly so a future edit can't flip it by
 *    accident) and `onEvent` is left unset, so no request/response/session
 *    detail is ever captured, let alone written anywhere.
 *  - No content identifiers in caller-originating query strings: this route
 *    takes no query params at all (Streamable HTTP is POST-body JSON-RPC,
 *    same "never a query string" posture as app/api/district's house
 *    pattern) - every tool argument arrives in the POST body.
 *  - Every argument that reaches a tool handler is the caller's own lookup
 *    key (a ZIP, a slug, a bioguide, a search string) - nothing here writes
 *    it anywhere; it's read once, used to look up baked JSON, and discarded
 *    when the response is returned.
 *
 * Bilingual-parity scope note (the fix that closed the envelope/refine_hint/
 * tool-error gap PR #46 pinned): the `title`/`description` on each
 * registerTool call below, and every zod `.describe()` schema string
 * (including localeSchema's own "en (default) or es" line), stay
 * English-only, deliberately. Those strings are tool/schema metadata the
 * calling agent's model reads to decide how to call the tool - they are
 * never returned in a response payload and never relayed to the end user
 * verbatim, unlike `meta`'s envelope fields or a toolError() message. Every
 * string that IS returned to a caller - the citation envelope
 * (lib/core/mcp.ts), lookup_representatives' `refine_hint`, and every
 * toolError() message below - is now locale-paired.
 */
export const dynamic = 'force-dynamic';

/** The shape every registerTool callback returns - matches the SDK's
 *  CallToolResult closely enough to satisfy it structurally without
 *  importing a type from a subpath this repo hasn't otherwise depended on. */
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function toolResult(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const localeSchema = z.enum(['en', 'es']).optional().describe('Response language: "en" (default) or "es".');

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      'lookup_representatives',
      {
        title: 'Look up representatives by ZIP',
        description:
          "Look up a person's U.S. House member and two Senators by 5-digit ZIP code. Returns each " +
          "member's name, party, phone, official website, portrait URL, and district office phone " +
          'numbers - the number a constituent should actually call. Some ZIP codes span more than one ' +
          'congressional district (needs_address: true, all candidate districts returned); this tool ' +
          'does not perform address-level refinement itself in this release - point the person to the ' +
          "response's reps_url, where a stateless, unlogged Census-geocoder proxy narrows it to a " +
          'single district from a street address that Rostra never stores. When a House seat currently ' +
          'has no member, `vacancies` lists the empty seat(s) (state + district) explicitly - the ' +
          'departed member is never returned as if still serving, and no election timeline is implied.',
        inputSchema: {
          zip: z
            .string()
            .regex(/^\d{5}$/, 'ZIP code must be exactly 5 digits.')
            .describe('5-digit U.S. ZIP code.'),
          locale: localeSchema,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ zip, locale }) => {
        const loc = normalizeLocale(locale);
        const result = lookupRepresentatives(zip, loc);
        if (!result) return toolError(noDistrictDataError(zip, loc));
        return toolResult(result);
      }
    );

    server.registerTool(
      'get_bill',
      {
        title: 'Get a bill decode',
        description:
          'Get the full plain-language decode of a federal bill by slug (e.g. "hr-2701-119") or ' +
          'citation (e.g. "H.R. 2701" - resolves to the most recent Congress on a match). Returns the ' +
          'AI-generated summary (headline, tl;dr, what/who/why/cost - human-reviewed before publish and ' +
          'clearly labeled when present), the official status in plain language, an urgency band, ' +
          "sponsor, key dates, the official Congress.gov page, and an act_url to Rostra's on-site call " +
          'flow. This tool never drafts a phone script - script generation only happens on-site, behind ' +
          'a human-review step, never over this API.',
        inputSchema: {
          slug: z
            .string()
            .optional()
            .describe('Bill slug, e.g. "hr-2701-119". Takes priority over citation when both are given.'),
          citation: z
            .string()
            .optional()
            .describe('Bill citation, e.g. "H.R. 2701" or "S.J.Res. 99". Used only when slug is omitted.'),
          locale: localeSchema,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ slug, citation, locale }) => {
        const loc = normalizeLocale(locale);
        if (!slug && !citation) return toolError(missingBillIdentifierError(loc));
        const result = getBillDetail({ slug, citation }, loc);
        if (!result) return toolError(billNotFoundError({ slug, citation }, loc));
        return toolResult(result);
      }
    );

    server.registerTool(
      'search_bills',
      {
        title: 'Search bills',
        description:
          "Search Rostra's bilingual federal bill corpus by free-text query, issue topic, status, or " +
          'active-only. Returns short teasers (headline, status, urgency) for matching bills, most ' +
          'urgent first.',
        inputSchema: {
          query: z.string().optional().describe('Free-text search over the bill title and plain-language summary.'),
          topic: z.enum(CATEGORIES).optional().describe('One of the 12 issue categories.'),
          status: z.enum(BILL_STATUSES).optional().describe('Bill status to filter to.'),
          active_only: z.boolean().optional().describe('Exclude signed/vetoed (terminal) bills when true.'),
          locale: localeSchema,
          limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20, max 50).'),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ query, topic, status, active_only, locale, limit }) => {
        const result = searchBills(
          { query, topic, status, activeOnly: active_only, limit },
          normalizeLocale(locale)
        );
        return toolResult(result);
      }
    );

    server.registerTool(
      'whats_moving',
      {
        title: "What's moving in Congress",
        description:
          "What's moving in Congress recently: active, plain-language-decoded bills that cleared " +
          "Rostra's 'act now' urgency bar within the last N days (default 7), optionally filtered by " +
          'topic. Returns an honest empty list with quiet_week: true when nothing has cleared the bar - ' +
          'this tool never pads the list to look busier than Congress actually is this week. If the ' +
          "list is empty because Rostra's own data sync looks stale rather than Congress being quiet, " +
          'data_stale is set instead so that distinction is never lost.',
        inputSchema: {
          days: z.number().int().min(1).max(90).optional().describe('Lookback window in days (default 7).'),
          topic: z.enum(CATEGORIES).optional().describe('One of the 12 issue categories.'),
          locale: localeSchema,
          limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10, max 50).'),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ days, topic, locale, limit }) => {
        const result = whatsMoving({ days, topic, limit }, normalizeLocale(locale));
        return toolResult(result);
      }
    );

    server.registerTool(
      'get_representative',
      {
        title: 'Get a representative',
        description:
          'Get full details for one member of Congress by bioguide ID (e.g. "W000797"), plus their 5 ' +
          'most recently active sponsored bills. Facts only: no scorecards, ratings, or vote grades.',
        inputSchema: {
          bioguide: z.string().min(1).describe('Bioguide ID, e.g. "W000797".'),
          locale: localeSchema,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ bioguide, locale }) => {
        const loc = normalizeLocale(locale);
        const result = getRepresentativeDetail(bioguide, loc);
        if (!result) return toolError(representativeNotFoundError(bioguide, loc));
        return toolResult(result);
      }
    );
  },
  {
    serverInfo: { name: 'rostra', version: '0.1.0' },
  },
  {
    basePath: '/api/mcp',
    disableSse: true,
    verboseLogs: false,
  }
);

/*
 * Anonymous (keyless) rate limits per the S11 spec: 60 requests/min and
 * 1,000/day per caller, enforced with the same short-lived rate-limit
 * counters as the rest of the API surface (lib/ratelimit.ts — hashed
 * caller only; a tool name never reaches a counter key, by construction:
 * the limiter API only accepts a caller IP and a closed route label).
 * Only POST carries JSON-RPC work, so only POST is limited; GET/DELETE
 * are the transport's cheap 405s. Degrades to per-instance in-memory
 * counters when Upstash is unconfigured or unreachable, like every route.
 */
const minuteLimiter = createRateLimiter({ route: 'mcp-min', max: 60, windowSec: 60 });
const dayLimiter = createRateLimiter({ route: 'mcp-day', max: 1000, windowSec: 86400 });

async function limitedPost(req: Request): Promise<Response> {
  readRostraKey(req.headers); // dormant tenancy hook (S18/S19): recognized, no behavior yet

  const ip = callerIp(req.headers);
  if (await minuteLimiter.isLimited(ip)) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'retry-after': '60' } }
    );
  }
  if (await dayLimiter.isLimited(ip)) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'retry-after': '3600' } }
    );
  }
  return handler(req);
}

export { handler as GET, limitedPost as POST, handler as DELETE };
