/*
 * RSS 2.0 XML escaping/serialization primitives (S21) — the ONE genuinely
 * new piece of logic the tenant feed adds (lib/core/feed.ts is otherwise a
 * thin reshaping of whatsMoving()'s existing output). Split into its own
 * dependency-free module, separate from lib/core/feed.ts itself, so it can
 * be unit-tested by direct import: lib/core/feed.ts pulls in lib/core/mcp.ts
 * -> lib/freshness.ts -> `import 'server-only'`, and `server-only` resolves
 * only inside Next's own bundler (aliased in next/dist/compiled, not a real
 * node_modules package) — confirmed empirically, the same class of gap
 * S19's own STATUS entry documented for /api/script ("can't be require()'d
 * in a unit spec"). This file imports nothing beyond the language itself,
 * so tests/tenant-feed.unit.spec.ts can import it directly; the rest of the
 * feed (buildFeedPayload/buildFeedRss's actual bill content) is pinned as
 * e2e instead (tests/tenant-feed.spec.ts), same split S19 already used.
 */

export function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** RFC 822 date string (RSS 2.0's required pubDate/lastBuildDate format). Unparseable/absent input falls back to `fallbackIso` rather than emitting an invalid date. */
export function rfc822(dateStr: string | null, fallbackIso: string): string {
  const parsed = dateStr ? new Date(dateStr) : null;
  const d = parsed && Number.isFinite(parsed.getTime()) ? parsed : new Date(fallbackIso);
  return d.toUTCString();
}
