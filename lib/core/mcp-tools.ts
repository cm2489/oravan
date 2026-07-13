/*
 * MCP tool DEFINITIONS (S10; extracted feat/mcp-stdio-entry): the 5
 * registerTool() calls app/api/mcp/[transport]/route.ts used to make
 * directly against mcp-handler's server callback - same zod input schemas,
 * same annotations (readOnlyHint/openWorldHint), same TOOL_INFO title/
 * description strings, same pure handler bodies calling this module's own
 * lookupRepresentatives/getBillDetail/searchBills/whatsMoving/
 * getRepresentativeDetail - moved here unchanged, behind one exported
 * `registerOravanTools(server, opts)`, so a second transport (stdio,
 * lib/mcp-stdio.ts) can register the identical 5 tools without a second
 * hand-copy that could silently drift from the live HTTP route.
 *
 * Route-specific/transport-specific concerns stay OUT of this file by
 * design: rate limiting wraps the HTTP route's POST handler, not any
 * individual tool, so it stays in route.ts untouched. The one thing that
 * genuinely differs per transport - what happens when a tool is called, for
 * usage-counting purposes - is threaded through as `opts.onToolCall`
 * instead: route.ts wires it to its after()-deferred Upstash usage-counter
 * write (see route.ts's own header comment); lib/mcp-stdio.ts passes a
 * no-op (see that file's header comment for why a local stdio process
 * deliberately never touches that database at all). This module has no
 * opinion on which - it just calls the hook once per invocation.
 *
 * tests/mcp.spec.ts + tests/mcp-tools.spec.ts are the pinning proof for the
 * HTTP side of this extraction: they hit the live route over real HTTP,
 * unchanged, and must keep passing byte-for-byte - this move changes WHERE
 * the registration code lives, never WHAT it does. tests/mcp-stdio.unit.
 * spec.ts is the equivalent pin for the stdio side.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CATEGORIES } from '../taxonomy';
import { BILL_STATUSES } from '../types';
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
  TOOL_INFO,
  whatsMoving,
  type ToolName,
} from './mcp';

/** The shape every registerTool callback returns - matches the SDK's
 *  CallToolResult closely enough to satisfy it structurally without
 *  importing a type from a subpath this repo hasn't otherwise depended on. */
export type ToolResult = {
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

export interface RegisterOravanToolsOptions {
  /** Called once per tool invocation, synchronously, before the handler
   *  itself runs - the one transport-specific hook this module exposes.
   *  Every OTHER concern (schemas, annotations, handler bodies) is
   *  identical across transports by construction; this is deliberately the
   *  single seam where they're allowed to differ. See this file's header
   *  comment for what each transport wires here. */
  onToolCall: (tool: ToolName) => void;
}

/*
 * Usage-counting wrapper (traffic-watch design, 2026-07; relocated here
 * unchanged from route.ts's own `withUsage`): one call site instead of five
 * edits scattered through each handler body. Counts every INVOCATION
 * regardless of outcome (a toolError result still counts - "how many times
 * was the tool called," not a success-rate metric). `onToolCall` runs
 * before `fn`, same order as the original route.ts implementation (which
 * called `after(() => noteMcpToolCall(tool))` first, then `fn(...args)`) -
 * preserved here so the HTTP route's observable behavior doesn't shift by
 * so much as an ordering guarantee.
 */
function withUsage<A extends unknown[]>(
  tool: ToolName,
  onToolCall: (tool: ToolName) => void,
  fn: (...args: A) => Promise<ToolResult>
): (...args: A) => Promise<ToolResult> {
  return (...args: A): Promise<ToolResult> => {
    onToolCall(tool);
    return fn(...args);
  };
}

/**
 * Register all 5 read-only Oravan MCP tools on `server` - identical zod
 * schemas, annotations, and handler bodies regardless of which transport
 * `server` is attached to (Streamable HTTP via mcp-handler, or stdio via
 * lib/mcp-stdio.ts). Every tool is readOnlyHint + openWorldHint:false (see
 * app/api/mcp/[transport]/route.ts's header comment for the full
 * constitution-check writeup this design carries forward unchanged).
 */
export function registerOravanTools(server: McpServer, opts: RegisterOravanToolsOptions): void {
  server.registerTool(
    'lookup_representatives',
    {
      ...TOOL_INFO.lookup_representatives,
      inputSchema: {
        zip: z
          .string()
          .regex(/^\d{5}$/, 'ZIP code must be exactly 5 digits.')
          .describe('5-digit U.S. ZIP code.'),
        locale: localeSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    withUsage('lookup_representatives', opts.onToolCall, async ({ zip, locale }) => {
      const loc = normalizeLocale(locale);
      const result = lookupRepresentatives(zip, loc);
      if (!result) return toolError(noDistrictDataError(zip, loc));
      return toolResult(result);
    })
  );

  server.registerTool(
    'get_bill',
    {
      ...TOOL_INFO.get_bill,
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
    withUsage('get_bill', opts.onToolCall, async ({ slug, citation, locale }) => {
      const loc = normalizeLocale(locale);
      if (!slug && !citation) return toolError(missingBillIdentifierError(loc));
      const result = getBillDetail({ slug, citation }, loc);
      if (!result) return toolError(billNotFoundError({ slug, citation }, loc));
      return toolResult(result);
    })
  );

  server.registerTool(
    'search_bills',
    {
      ...TOOL_INFO.search_bills,
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
    withUsage('search_bills', opts.onToolCall, async ({ query, topic, status, active_only, locale, limit }) => {
      const result = searchBills(
        { query, topic, status, activeOnly: active_only, limit },
        normalizeLocale(locale)
      );
      return toolResult(result);
    })
  );

  server.registerTool(
    'whats_moving',
    {
      ...TOOL_INFO.whats_moving,
      inputSchema: {
        days: z.number().int().min(1).max(90).optional().describe('Lookback window in days (default 7).'),
        topic: z.enum(CATEGORIES).optional().describe('One of the 12 issue categories.'),
        locale: localeSchema,
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10, max 50).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    withUsage('whats_moving', opts.onToolCall, async ({ days, topic, locale, limit }) => {
      const result = whatsMoving({ days, topic, limit }, normalizeLocale(locale));
      return toolResult(result);
    })
  );

  server.registerTool(
    'get_representative',
    {
      ...TOOL_INFO.get_representative,
      inputSchema: {
        bioguide: z.string().min(1).describe('Bioguide ID, e.g. "W000797".'),
        locale: localeSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    withUsage('get_representative', opts.onToolCall, async ({ bioguide, locale }) => {
      const loc = normalizeLocale(locale);
      const result = getRepresentativeDetail(bioguide, loc);
      if (!result) return toolError(representativeNotFoundError(bioguide, loc));
      return toolResult(result);
    })
  );
}
