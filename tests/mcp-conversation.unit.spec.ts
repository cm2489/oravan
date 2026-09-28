import { expect, test } from '@playwright/test';
import { conversationEvidence, dayKey, MOST_VIEWED_MIN_WEEKS } from '../lib/conversation.mjs';
import { conversationFile } from '../lib/conversation';
import { conversationFacet } from '../lib/core/mcp-conversation';

/*
 * MCP `whats_moving`'s `conversation` facet carries NOTHING from AllSides
 * (owner decision 2026-09-28: "Remove allsides leans from MCP").
 *
 * /citations says AllSides' outlet-lean ratings "are excluded from the MCP
 * server" (citations.licenseCoverage). These tests are what make that sentence
 * checkable: the facet has no lean and no rated-outlet count, and a bill's
 * facet is the same whatever the AllSides table says about the outlets that
 * covered it — take the outlets away, or flip every lean, and nothing changes.
 *
 * The facet function is pinned here on fixtures, run through the real
 * evidence reader (lib/conversation.mjs's conversationEvidence), because
 * lib/core/mcp.ts cannot load under the unit runner. The tool's wiring is
 * pinned over the real stdio entry in tests/mcp-stdio.unit.spec.ts and over
 * HTTP in tests/mcp-tools.spec.ts.
 */

const T = '2026-09-28';
const minus = (days: number) => dayKey(Date.parse(`${T}T00:00:00Z`) - days * 86_400_000);
const outlet = (domain: string, lean: string, seen = T) => ({ domain, lean, firstSeen: seen, lastSeen: seen });
const listing = (weeksOnList: number, lastRank: number, lastSeen = T) => ({
  weeksOnList,
  lastRank,
  lastSeen,
  lastWeek: lastSeen,
});
const facetOf = (entry: unknown, today = T) => conversationFacet(conversationEvidence(entry, { today }));

/** The same entry with every AllSides-derived input removed, or with every lean flipped. */
const withoutOutlets = (entry: Record<string, unknown>) => ({ ...entry, outlets7d: [], unratedOutlets7d: [] });
const FLIP: Record<string, string> = { left: 'right', right: 'left', center: 'left' };
const withLeansFlipped = (entry: { outlets7d?: Array<{ lean: string }> }) => ({
  ...entry,
  outlets7d: (entry.outlets7d ?? []).map((o) => ({ ...o, lean: FLIP[o.lean] ?? o.lean })),
});

const FIXTURES: Record<string, Record<string, unknown>> = {
  'C1, press only (two rated outlets, not on the list)': {
    outlets7d: [outlet('foxnews.com', 'right'), outlet('cbsnews.com', 'left', minus(1))],
  },
  'C1, one-sided press only': {
    outlets7d: [outlet('foxnews.com', 'right'), outlet('nypost.com', 'right')],
  },
  'C2, a first-week listing with one rated article beside it': {
    outlets7d: [outlet('politico.com', 'left')],
    mostViewed: listing(1, 1),
  },
  'C2, two weeks on the list, no press': {
    outlets7d: [],
    mostViewed: listing(MOST_VIEWED_MIN_WEEKS, 4),
  },
  'C1 and three weeks on the list': {
    outlets7d: [outlet('foxnews.com', 'right'), outlet('cbsnews.com', 'left'), outlet('reuters.com', 'center')],
    mostViewed: listing(3, 2),
  },
  'a listing that fell off more than a week ago': {
    outlets7d: [],
    mostViewed: listing(5, 1, minus(9)),
  },
  'a first-week listing alone': {
    outlets7d: [],
    mostViewed: listing(1, 1),
  },
};

test.describe('MCP conversation facet (lib/core/mcp-conversation.ts)', () => {
  test('carries only the most-viewed listing: two keys, and no lean or outlet count', () => {
    const facet = facetOf(FIXTURES['C1 and three weeks on the list']);
    expect(facet).toEqual({ most_viewed_rank: 2, most_viewed_weeks: 3 });
    expect(Object.keys(facet!).sort()).toEqual(['most_viewed_rank', 'most_viewed_weeks']);
  });

  test('press alone never earns the facet, however many rated outlets or leans', () => {
    expect(facetOf(FIXTURES['C1, press only (two rated outlets, not on the list)'])).toBeUndefined();
    expect(facetOf(FIXTURES['C1, one-sided press only'])).toBeUndefined();
  });

  test('a first-week listing does not earn it, with or without a rated article beside it', () => {
    expect(facetOf(FIXTURES['C2, a first-week listing with one rated article beside it'])).toBeUndefined();
    expect(facetOf(FIXTURES['a first-week listing alone'])).toBeUndefined();
  });

  test(`${MOST_VIEWED_MIN_WEEKS} weeks running on congress.gov's list earns it, with no press at all`, () => {
    expect(facetOf(FIXTURES['C2, two weeks on the list, no press'])).toEqual({
      most_viewed_rank: 4,
      most_viewed_weeks: MOST_VIEWED_MIN_WEEKS,
    });
  });

  test('a listing outside the seven-day window earns nothing', () => {
    expect(facetOf(FIXTURES['a listing that fell off more than a week ago'])).toBeUndefined();
  });

  test('no evidence, no facet', () => {
    expect(conversationFacet(null)).toBeUndefined();
    expect(conversationFacet(undefined)).toBeUndefined();
  });

  test('the AllSides table cannot change any fixture: removing the outlets or flipping every lean gives the same facet', () => {
    for (const [name, entry] of Object.entries(FIXTURES)) {
      const facet = facetOf(entry);
      expect(facetOf(withoutOutlets(entry)), name).toEqual(facet);
      expect(facetOf(withLeansFlipped(entry)), name).toEqual(facet);
    }
  });

  test('no bill gains the facet: every bill that carries it now was in the old C1/C2 pool', () => {
    for (const [name, entry] of Object.entries(FIXTURES)) {
      if (facetOf(entry)) expect(conversationEvidence(entry, { today: T }).tier, name).not.toBe('c0');
    }
  });

  test('the committed evidence file: every facet is list-only and independent of the outlets', () => {
    const file = conversationFile();
    // Judged on the day the file was written, so the check is not vacuous on a
    // day the lamp has gone stale.
    const today = dayKey(Date.parse(file._meta.fetched_at));
    for (const [slug, entry] of Object.entries(file.slugs ?? {})) {
      const facet = facetOf(entry, today);
      if (facet) expect(Object.keys(facet).sort(), slug).toEqual(['most_viewed_rank', 'most_viewed_weeks']);
      expect(facetOf(withoutOutlets(entry as unknown as Record<string, unknown>), today), slug).toEqual(facet);
    }
  });
});
