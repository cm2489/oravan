/*
 * `whats_moving`'s OPTIONAL `conversation` FACET — congress.gov's own
 * most-viewed list, and nothing from AllSides.
 *
 * Owner decision, 2026-09-28: "Remove allsides leans from MCP". The facet used
 * to carry `lean_spread` (the AllSides leans of the rated outlets covering a
 * bill) and `outlets_7d` (how many AllSides-rated outlets covered it), and a
 * bill could earn it by two routes that read the AllSides table: two or more
 * rated outlets (C1), or one rated article beside a first-week listing (C2).
 * All of that is gone. /citations says AllSides' ratings "are excluded from
 * the MCP server" (`citations.licenseCoverage`); this function is what keeps
 * that sentence true.
 *
 * What is left is the one route that never reads the AllSides table: the bill
 * is on congress.gov's current most-viewed list and has been for at least
 * MOST_VIEWED_MIN_WEEKS weeks running. That is the bar lib/conversation.mjs
 * already sets for a listing with nothing beside it, so every bill that
 * carries the facet now also carried it before; none is new.
 *
 * Pure and free of `server-only`, so tests/mcp-conversation.unit.spec.ts pins
 * it on fixtures (lib/core/mcp.ts itself cannot load under the unit runner).
 */
import { MOST_VIEWED_MIN_WEEKS, type ConversationEvidence } from '../conversation';

export interface BillConversationOut {
  /** Rank on congress.gov's most recent weekly most-viewed list. */
  most_viewed_rank: number | null;
  /** Consecutive weeks on that list. */
  most_viewed_weeks: number;
}

/** The facet for one bill's stored evidence, or undefined when congress.gov's
 *  list alone would not have admitted it. */
export function conversationFacet(
  evidence: Pick<ConversationEvidence, 'mostViewed' | 'weeksOnList'> | null | undefined
): BillConversationOut | undefined {
  if (!evidence?.mostViewed || evidence.weeksOnList < MOST_VIEWED_MIN_WEEKS) return undefined;
  return {
    most_viewed_rank: evidence.mostViewed.lastRank ?? null,
    most_viewed_weeks: evidence.weeksOnList,
  };
}
